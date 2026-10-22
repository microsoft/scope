// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "@/contexts/AuthContext";
import { signedInAuth } from "@/contexts/authFixtures";
import { ProjectProvider, useProjectContext } from "@/contexts/ProjectContext";
import { PROJECT_STORAGE_KEY } from "@/lib/project-scope";
import { resetApiClient, setApiSessionSignal } from "@/lib/api-client";
import { openAuthenticatedMedia, type MediaBridge } from "@/lib/authenticated-media";
import { VideoPlayer } from "./VideoPlayer";

vi.mock("@/lib/authenticated-media", () => ({ openAuthenticatedMedia: vi.fn() }));
const open = vi.mocked(openAuthenticatedMedia);
const path = "/api/v1/requests/one/runs/attempt-1/video";
const secondPath = "/api/v1/requests/one/runs/attempt-2/video";
const bridge = () => ({ url: "https://scope.test/__scope_media__/example", close: vi.fn() });

function ProjectSwitch() {
  const { setSelectedProjectId } = useProjectContext();
  return <button onClick={() => setSelectedProjectId("second-project")}>Switch project</button>;
}
function tree(src = path, auth: AuthContextValue = signedInAuth) {
  return <AuthContext.Provider value={auth}><ProjectProvider>
    <ProjectSwitch /><VideoPlayer src={src} label="Recording" />
  </ProjectProvider></AuthContext.Provider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem(PROJECT_STORAGE_KEY, "demo-project");
  open.mockImplementation(async () => bridge());
});
afterEach(() => { cleanup(); localStorage.removeItem(PROJECT_STORAGE_KEY); resetApiClient(); });

it("uses only the bridge URL with metadata preload, never a direct protected src", async () => {
  render(tree());
  await waitFor(() => expect(screen.getByLabelText("Recording").getAttribute("src")).toContain("/__scope_media__/"));
  expect(open).toHaveBeenCalledWith(path, "demo-project", expect.any(AbortSignal), expect.any(Function));
  expect(screen.getByLabelText("Recording").getAttribute("preload")).toBe("metadata");
});

it("defers bridge creation until project and auth are ready", () => {
  render(tree(path, { ...signedInAuth, isReady: false }));
  expect(open).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Recording").getAttribute("src")).toBeNull();
});

it("shows explicit failure and retries with a fresh bridge", async () => {
  open.mockRejectedValueOnce(new Error("Another service worker controls this app."));
  render(tree());
  expect((await screen.findByRole("alert")).textContent).toContain("Another service worker");
  fireEvent.click(screen.getByRole("button", { name: "Retry recording" }));
  await waitFor(() => expect(screen.getByLabelText("Recording").getAttribute("src")).toContain("/__scope_media__/"));
  expect(open).toHaveBeenCalledTimes(2);
});

it("closes bridge and clears the native source on unmount", async () => {
  const delivery = bridge();
  open.mockResolvedValue(delivery);
  const view = render(tree());
  const video = screen.getByLabelText("Recording");
  await waitFor(() => expect(video.getAttribute("src")).toBe(delivery.url));
  const signal = open.mock.calls[0][2];
  view.unmount();
  expect(signal.aborted).toBe(true);
  expect(delivery.close).toHaveBeenCalled();
  expect(video.getAttribute("src")).toBeNull();
});

it.each(["attempt", "project", "account"])("hides stale playback and cancels the old %s identity", async change => {
  const first = bridge();
  let resolve!: (value: MediaBridge) => void;
  open.mockResolvedValueOnce(first).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = render(tree());
  await waitFor(() => expect(screen.getByLabelText("Recording").getAttribute("src")).toBe(first.url));
  const oldSignal = open.mock.calls[0][2];
  if (change === "attempt") view.rerender(tree(secondPath));
  else if (change === "project") fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
  else view.rerender(tree(path, { ...signedInAuth, account: { ...signedInAuth.account!, homeAccountId: "new-account" } }));
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  expect(oldSignal.aborted).toBe(true);
  expect(first.close).toHaveBeenCalled();
  expect(screen.getByLabelText("Recording").getAttribute("src")).toBeNull();
  await act(async () => resolve(bridge()));
});

it("does not publish a late bridge after logout and closes it instead", async () => {
  let resolve!: (value: MediaBridge) => void;
  open.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const account = new AbortController();
  setApiSessionSignal(account.signal);
  render(tree());
  const delivery = bridge();
  account.abort();
  await act(async () => resolve(delivery));
  expect(delivery.close).toHaveBeenCalled();
  expect(screen.getByLabelText("Recording").getAttribute("src")).toBeNull();
});

it("clears already-playing native media synchronously when the account signal aborts", async () => {
  const account = new AbortController();
  setApiSessionSignal(account.signal);
  render(tree());
  const video = screen.getByLabelText("Recording");
  await waitFor(() => expect(video.getAttribute("src")).toContain("/__scope_media__/"));
  account.abort();
  expect(video.getAttribute("src")).toBeNull();
  expect(open.mock.calls[0][2].aborted).toBe(true);
});

it("survives StrictMode setup/cleanup without retaining an aborted bridge", async () => {
  render(<StrictMode>{tree()}</StrictMode>);
  await waitFor(() => expect(screen.getByLabelText("Recording").getAttribute("src")).toContain("/__scope_media__/"));
  expect(open.mock.calls[0][2].aborted).toBe(true);
  expect(open.mock.calls.at(-1)![2].aborted).toBe(false);
});

it("closes delivery after a native playback/worker-restart error", async () => {
  const delivery = bridge();
  open.mockResolvedValue(delivery);
  render(tree());
  const video = screen.getByLabelText("Recording");
  await waitFor(() => expect(video.getAttribute("src")).toBe(delivery.url));
  fireEvent.error(video);
  expect(delivery.close).toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("Unable to play the recording");
});
