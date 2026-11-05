// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { act, screen } from "@testing-library/react";
import type { Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { exampleToken, summaryRun } from "@/components/run-sharing/fixtures";

const state = vi.hoisted(() => ({ root: null as Root | null, privateImport: vi.fn() }));
vi.mock("./private-main", () => {
  state.privateImport();
  throw new Error("Public bootstrap must not load private auth");
});
vi.mock("react-dom/client", async (original) => {
  const actual = await original<typeof import("react-dom/client")>();
  return { ...actual, createRoot: (container: HTMLElement) => {
    state.root = actual.createRoot(container);
    return state.root;
  } };
});
afterEach(async () => {
  await act(async () => state.root?.unmount());
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

it("boots the actual anonymous provider tree without importing MSAL or private providers", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  window.history.replaceState(null, "", `/shared/runs#${exampleToken}`);
  const paths: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (req: Request) => {
    paths.push(new URL(req.url).pathname);
    return new Response(JSON.stringify(summaryRun), { headers: { "Content-Type": "application/json" } });
  }));
  await act(async () => { await (await import("./main")).bootstrapped; });
  await screen.findByText("React benchmark");
  expect(paths).toEqual(["/api/v1/shared/runs/view"]);
  expect(state.privateImport).not.toHaveBeenCalled();
  expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toContain("noindex");
});
