// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Share2 } from "lucide-react";
import { toast } from "sonner";
import {
  FULL_SHARE_CONTENT, SUMMARY_SHARE_CONTENT, RUN_SHARE_CATEGORIES, hasDetailedShareContent,
  type RunShare, type RunShareContent, type RunShareLink, type CreateRunShare,
} from "shared/run-sharing";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

function localExpiry(value: string | Date): string {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

interface ShareRunDialogProps {
  requestId: string;
  runId: string;
  attemptNumber: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShareRunDialog({ requestId, runId, attemptNumber, open, onOpenChange }: ShareRunDialogProps) {
  const id = useId();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("Shared run");
  const [content, setContent] = useState<RunShareContent>({ ...SUMMARY_SHARE_CONTENT });
  const [expiry, setExpiry] = useState(() => localExpiry(new Date(Date.now() + 7 * 86_400_000)));
  const [noExpiry, setNoExpiry] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [freshLink, setFreshLink] = useState<{ id: string; url: string } | null>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (freshLink) linkInput.current?.focus(); }, [freshLink]);
  const [formError, setFormError] = useState<string | null>(null);
  const queryKey = ["run-shares", requestId, runId];
  const shares = useInfiniteQuery({
    queryKey, enabled: open,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listRunShares(requestId, runId, pageParam),
    getNextPageParam: (page) => page.next ?? undefined,
    gcTime: 0,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey });
  const save = useMutation({
    gcTime: 0,
    mutationFn: ({ body, shareId }: { body: CreateRunShare; shareId: string | null }): Promise<RunShareLink | RunShare> =>
      shareId ? api.updateRunShare(requestId, runId, shareId, body)
        : api.createRunShare(requestId, runId, body),
    onSuccess: (result) => {
      if ("path" in result) setFreshLink({ id: result.share.id, url: new URL(result.path, window.location.origin).href });
      toast.success("path" in result ? "Shared link created" : "Shared link updated");
      setEditing(null);
      setAcknowledged(false);
      void invalidate();
    },
    onError: (error) => setFormError(error.message),
  });
  const rotate = useMutation({
    gcTime: 0,
    mutationFn: (shareId: string) => api.rotateRunShare(requestId, runId, shareId),
    onSuccess: (result) => {
      setFreshLink({ id: result.share.id, url: new URL(result.path, window.location.origin).href });
      toast.success("Link rotated. The previous URL no longer works.");
      void invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const revoke = useMutation({
    gcTime: 0,
    mutationFn: (shareId: string) => api.revokeRunShare(requestId, runId, shareId),
    onSuccess: (result) => {
      if (freshLink?.id === result.id) setFreshLink(null);
      if (editing === result.id) setEditing(null);
      toast.success("Shared link revoked");
      void invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const busy = save.isPending || rotate.isPending || revoke.isPending;
  const detailed = hasDetailedShareContent(content);
  const items = shares.data?.pages.flatMap((page) => page.data) ?? [];

  function edit(share: RunShare) {
    setEditing(share.id);
    setLabel(share.label);
    setContent({ ...share.content });
    setNoExpiry(share.expiresAt === null);
    if (share.expiresAt) setExpiry(localExpiry(share.expiresAt));
    setAcknowledged(false);
    setFormError(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const date = noExpiry ? null : new Date(expiry);
    if (date && (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now())) {
      setFormError("Choose an expiry in the future.");
      return;
    }
    save.mutate({
      shareId: editing,
      body: { label, content, expiresAt: date?.toISOString() ?? null, acknowledgeSensitiveContent: acknowledged },
    });
  }

  async function copyLink() {
    if (!freshLink) return;
    try {
      await navigator.clipboard.writeText(freshLink.url);
      toast.success("Shared URL copied");
    } catch {
      toast.error("Clipboard unavailable. Select and copy the URL instead.");
    }
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
    <DialogContent className="max-h-[90vh] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0">
      <DialogHeader className="px-6 pb-4 pt-6">
        <DialogTitle>Share run · Attempt {attemptNumber}</DialogTitle>
        <DialogDescription>Anyone with the link can view the selected content without signing in. This never includes later retry attempts.</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 space-y-6 overflow-y-auto px-6 pb-6">
        {freshLink && <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <p className="text-sm font-medium">Save this URL now</p>
          <p className="text-xs text-muted-foreground">Its secret is shown only after creation or rotation. Scope stores only a hash.</p>
          <div className="flex gap-2">
            <Input ref={linkInput} className="min-w-0" aria-label="Shared URL" readOnly value={freshLink.url} onFocus={(event) => event.currentTarget.select()} />
            <Button type="button" variant="outline" onClick={() => void copyLink()}>Copy URL</Button>
          </div>
          <a href={freshLink.url} target="_blank" rel="noopener noreferrer" className="text-sm underline">Open shared view</a>
        </div>}
        <form id={`${id}-form`} onSubmit={submit} className="space-y-4">
          <h2 className="text-sm font-semibold">{editing ? "Edit link" : "Create a link"}</h2>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-label`} className="text-sm font-medium">Link label</label>
            <Input id={`${id}-label`} required maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} />
          </div>
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-medium">Content preset</legend>
            <div className="flex gap-2">
              <Button type="button" variant={!detailed ? "default" : "outline"} aria-pressed={!detailed} onClick={() => { setContent({ ...SUMMARY_SHARE_CONTENT }); setAcknowledged(false); }}>Summary</Button>
              <Button type="button" variant={JSON.stringify(content) === JSON.stringify(FULL_SHARE_CONTENT) ? "default" : "outline"} aria-pressed={JSON.stringify(content) === JSON.stringify(FULL_SHARE_CONTENT)} onClick={() => { setContent({ ...FULL_SHARE_CONTENT }); setAcknowledged(false); }}>Full detail</Button>
            </div>
            <p className="text-xs text-muted-foreground">Summary always includes status, agent/model, and structured iteration results. Customize additional sections below.</p>
            <div className="divide-y rounded-md border px-3">
              {RUN_SHARE_CATEGORIES.map((category) => <label key={category.key} className="flex cursor-pointer items-start gap-3 py-3">
                <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={content[category.key]}
                  onChange={(event) => { setContent({ ...content, [category.key]: event.target.checked }); setAcknowledged(false); }} />
                <span><span className="block text-sm font-medium">{category.label}</span><span className="block text-xs text-muted-foreground">{category.description}</span></span>
              </label>)}
            </div>
          </fieldset>
          <div className="rounded-md bg-muted/50 p-3 text-sm">
            <p className="font-medium">Shared view preview</p>
            <p className="mt-1 text-muted-foreground">{["Summary and results", ...RUN_SHARE_CATEGORIES.filter((category) => content[category.key]).map((category) => category.label)].join(" · ")}</p>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={noExpiry} onChange={(event) => setNoExpiry(event.target.checked)} />No expiry</label>
            {!noExpiry && <div className="space-y-1.5">
              <label htmlFor={`${id}-expiry`} className="text-sm font-medium">Expires at (your local time)</label>
              <Input id={`${id}-expiry`} type="datetime-local" required value={expiry} onChange={(event) => setExpiry(event.target.value)} />
            </div>}
          </div>
          {detailed && <div className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
            <p className="text-sm">Selected content may contain credentials, private code, or copies of other sections. Category switches are not automatic content redaction. Review the content before publishing.</p>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
              I have reviewed the selected content and understand it will be accessible to anyone with the link.
            </label>
          </div>}
          <p className="text-xs text-muted-foreground">Revoking a link stops future reads, but cannot remove content someone already downloaded.</p>
          {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
        </form>
        <section className="space-y-3 border-t pt-5">
          <h2 className="text-sm font-semibold">Your links for this attempt</h2>
          <p className="text-xs text-muted-foreground">Rotate replaces a URL and invalidates the old one. Revoked links cannot be reactivated.</p>
          {shares.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading your links...</p>}
          {shares.error && <p role="alert" className="text-sm text-destructive">{shares.error.message}</p>}
          {!shares.isLoading && !shares.error && items.length === 0 && <p className="text-sm text-muted-foreground">No shared links yet.</p>}
          {items.map((share) => <div key={share.id} className="space-y-2 rounded-md border p-3">
            <div className="flex items-start justify-between gap-3">
              <div><p className="text-sm font-medium">{share.label}</p><p className="text-xs text-muted-foreground">{share.expiresAt ? `Expires ${new Date(share.expiresAt).toLocaleString()}` : "No expiry"}</p></div>
              <Badge variant="outline">{share.revokedAt ? "Revoked" : share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now() ? "Expired" : "Active"}</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" aria-label={`Edit ${share.label}`} disabled={busy || !!share.revokedAt} onClick={() => edit(share)}>Edit</Button>
              <Button type="button" variant="outline" size="sm" aria-label={`Rotate ${share.label}`} disabled={busy || !!share.revokedAt} onClick={() => rotate.mutate(share.id)}>Rotate URL</Button>
              <Button type="button" variant="outline" size="sm" aria-label={`Revoke ${share.label}`} disabled={busy || !!share.revokedAt} onClick={() => revoke.mutate(share.id)}>Revoke</Button>
            </div>
          </div>)}
          {shares.hasNextPage && <Button type="button" variant="outline" disabled={shares.isFetchingNextPage} onClick={() => void shares.fetchNextPage()}>Load more links</Button>}
        </section>
      </div>
      <DialogFooter className="border-t bg-background px-6 py-4">
        {editing && <Button type="button" variant="outline" disabled={busy} onClick={() => { setEditing(null); setFormError(null); }}>Cancel editing</Button>}
        <Button type="submit" form={`${id}-form`} disabled={busy || (detailed && !acknowledged)}>
          {save.isPending ? "Saving..." : editing ? "Save link" : "Create link"}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function ShareRunButton({ requestId, runId, attemptNumber }: Omit<ShareRunDialogProps, "open" | "onOpenChange">) {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const version = useQuery({
    queryKey: ["version"], queryFn: api.getVersion,
    enabled: auth.isReady && auth.isAuthenticated,
  });
  if (!auth.isReady || !auth.isAuthenticated || !version.data?.runSharingEnabled) return null;
  return <>
    <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}><Share2 className="h-4 w-4" />Share</Button>
    {open && <ShareRunDialog requestId={requestId} runId={runId} attemptNumber={attemptNumber} open onOpenChange={setOpen} />}
  </>;
}
