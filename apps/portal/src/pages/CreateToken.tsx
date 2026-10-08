// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { KeyType, KeyValidationResult, CreateKeyRequest } from "@/types";
import { KEY_TYPE_LABELS, KEY_CAPABILITY_LABELS, KEY_TYPE_EXPECTED_CAPABILITIES } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Alert, AlertDescription, AlertTitle,
} from "@/components/ui/alert";
import { ArrowLeft, ArrowRight, Loader2, CheckCircle2, XCircle, AlertTriangle, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { useCommandEnter } from "@/hooks/useCommandEnter";
import { KbdBadge } from "@/components/KbdBadge";

const KEY_INSTRUCTIONS: Record<KeyType, { steps: string[]; link?: { label: string; url: string }; note?: string }> = {
  "github-pat-classic": {
    steps: [
      "Go to GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)",
      "Click 'Generate new token (classic)'",
      "Select scopes: 'copilot' (for Copilot SDK/CLI/VS Code) and/or 'repo' as needed",
      "Set an expiration and click 'Generate token'",
      "Copy the token (starts with ghp_)",
    ],
    link: { label: "Open GitHub token settings", url: "https://github.com/settings/tokens" },
    note: "Classic PATs cannot access GitHub Models. Use a fine-grained PAT with models:read for that.",
  },
  "github-pat-fine-grained": {
    steps: [
      "Go to GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens",
      "Click 'Generate new token'",
      "Set a token name, expiration, and resource owner",
      "Under Permissions, add 'Models' → Read access (for GitHub Models)",
      "Click 'Generate token'",
      "Copy the token (starts with github_pat_)",
    ],
    link: { label: "Open GitHub token settings", url: "https://github.com/settings/personal-access-tokens" },
    note: "Fine-grained PATs support GitHub Models via the models:read permission. They do not support Copilot SDK.",
  },
  "github-oauth": {
    steps: [
      "Obtain a GitHub OAuth token via an OAuth App flow (authorization code grant)",
      "The token should have the 'copilot' scope for Copilot capabilities",
      "Copy the OAuth access token",
    ],
    note: "OAuth tokens typically support all GitHub capabilities including Copilot SDK, CLI, VS Code, and GitHub Models.",
  },
  "github-oauth-cookie-state": {
    steps: [
      "Open VS Code for the Web (vscode.dev) and sign in with GitHub",
      "Open browser DevTools → Application → Cookies",
      "Find the GitHub auth cookies and export them as a JSON object",
      "Paste the full JSON blob below",
    ],
    note: "This cookie state is used by the VS Code Web worker to authenticate as a signed-in user.",
  },
  "anthropic-api-key": {
    steps: [
      "Go to the Anthropic Console → API Keys",
      "Click 'Create Key'",
      "Name the key and click 'Create'",
      "Copy the API key (starts with sk-ant-)",
    ],
    link: { label: "Open Anthropic Console", url: "https://console.anthropic.com/settings/keys" },
  },
  "anthropic-oauth": {
    steps: [
      "Set up a Claude Code subscription (Max or Team plan)",
      "Authenticate via 'claude login' in the CLI",
      "Copy the OAuth token from ~/.claude/credentials.json",
    ],
    note: "OAuth tokens from Claude Code subscriptions use Bearer authentication. The token format varies (not sk-ant-).",
  },
  "azure-ai-foundry": {
    steps: [
      "In the Azure portal, open (or create) an Azure AI Foundry / Azure AI Services resource",
      "Create a model deployment for the model you want to use (e.g. gpt-4.1, gpt-4.1-mini)",
      "Copy the endpoint URL — typically https://<resource>.services.ai.azure.com/models",
      "Copy one of the resource API keys",
      "Paste the endpoint, key, and (optionally) the deployment name below",
    ],
    link: { label: "Open Azure AI Foundry", url: "https://ai.azure.com/" },
    note: "Used by the portal's AI features (criteria / prompt-feature / task-prompt generation). When at least one valid Foundry key is registered the API prefers it over the slow public GitHub Models endpoint.",
  },
};

const KEY_TYPES: KeyType[] = [
  "github-pat-classic",
  "github-pat-fine-grained",
  "github-oauth",
  "github-oauth-cookie-state",
  "anthropic-api-key",
  "anthropic-oauth",
  "azure-ai-foundry",
];

/** Expected prefix per token type for surface-level validation. */
const KEY_PREFIXES: Record<KeyType, { prefix: string; description: string }> = {
  "github-pat-classic": { prefix: "ghp_", description: "ghp_" },
  "github-pat-fine-grained": { prefix: "github_pat_", description: "github_pat_" },
  "github-oauth": { prefix: "gho_", description: "gho_ or ghu_" }, // also ghu_ for user tokens
  "github-oauth-cookie-state": { prefix: "{", description: "JSON object" },
  "anthropic-api-key": { prefix: "sk-ant-", description: "sk-ant-" },
  "anthropic-oauth": { prefix: "", description: "(any format — OAuth token)" },
  "azure-ai-foundry": { prefix: "{", description: "JSON object (endpoint + apiKey)" },
};

/** Check if the token value matches the expected prefix for the selected type. */
function validateKeyPrefix(tokenType: KeyType, tokenValue: string): string | null {
  const trimmed = tokenValue.trim();
  if (!trimmed) return null; // Don't warn on empty input

  const expected = KEY_PREFIXES[tokenType];

  // Special case: github-oauth can start with gho_ or ghu_
  if (tokenType === "github-oauth") {
    if (trimmed.startsWith("gho_") || trimmed.startsWith("ghu_")) return null;
    return `Expected prefix: ${expected.description}`;
  }

  // Special case: anthropic-oauth has no fixed prefix
  if (tokenType === "anthropic-oauth") {
    return null;
  }

  // Special case: azure-ai-foundry is built from structured inputs, not a
  // raw paste — its prefix check is implicit (we serialize to JSON ourselves).
  if (tokenType === "azure-ai-foundry") {
    return null;
  }

  if (!trimmed.startsWith(expected.prefix)) {
    return `Expected prefix: ${expected.description}`;
  }

  return null; // Valid prefix
}

type Step = "input" | "review";

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "valid":
      return <CheckCircle2 className="h-5 w-5 text-green-500" />;
    case "invalid":
    case "expired":
      return <XCircle className="h-5 w-5 text-destructive" />;
    default:
      return <AlertTriangle className="h-5 w-5 text-yellow-500" />;
  }
}

export function buildFoundryCredentialValue(options: {
  endpoint: string;
  apiKey: string;
  model: string;
}): string {
  const endpoint = options.endpoint.trim().replace(/\/+$/, "");
  const apiKey = options.apiKey.trim();
  const model = options.model.trim();
  return JSON.stringify({
    endpoint,
    apiKey,
    ...(model ? { model } : {}),
  });
}

export function CreateToken() {
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>("input");
  const [type, setType] = useState<KeyType>("github-pat-classic");
  const [value, setValue] = useState("");
  // Structured fields for "azure-ai-foundry": the secret value is a JSON
  // blob built from { endpoint, apiKey, model? }. We keep them in separate
  // state so the form can render labelled inputs and we serialize on submit.
  const [foundryEndpoint, setFoundryEndpoint] = useState("");
  const [foundryApiKey, setFoundryApiKey] = useState("");
  const [foundryModel, setFoundryModel] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [comment, setComment] = useState("");
  const [previewResult, setPreviewResult] = useState<KeyValidationResult | null>(null);

  /**
   * Returns the secret string to send to the API. For Azure AI Foundry we
   * serialize the three structured fields into a JSON blob the token-manager
   * validator + the API's `acquireInferenceClient` know how to parse.
   */
  const getSubmitValue = (): string => {
    if (type === "azure-ai-foundry") {
      return buildFoundryCredentialValue({
        endpoint: foundryEndpoint,
        apiKey: foundryApiKey,
        model: foundryModel,
      });
    }
    return value.trim();
  };

  /** True when the user has supplied enough input to attempt validation. */
  const hasInput = (): boolean => {
    if (type === "azure-ai-foundry") {
      return !!foundryEndpoint.trim() && !!foundryApiKey.trim();
    }
    return !!value.trim();
  };

  const previewMutation = useMutation({
    mutationFn: () => api.previewKey({ type, value: getSubmitValue() }),
    onSuccess: (result) => {
      setPreviewResult(result);
      setStep("review");
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const createMutation = useMutation({
    mutationFn: (body: CreateKeyRequest) => api.createKey(body),
    onSuccess: (data) => {
      toast.success("Key registered successfully");
      navigate(`/secrets/keys/${data._id}`);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const doValidate = () => {
    if (!hasInput()) {
      toast.error(
        type === "azure-ai-foundry"
          ? "Endpoint URL and API key are required"
          : "Key value is required"
      );
      return;
    }
    if (type === "azure-ai-foundry") {
      const trimmed = foundryEndpoint.trim();
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== "https:") {
          toast.error("Endpoint URL must use https://");
          return;
        }
      } catch {
        toast.error("Endpoint URL is not a valid URL");
        return;
      }
    } else {
      const prefixError = validateKeyPrefix(type, value);
      if (prefixError) {
        toast.error(`Invalid key format: ${prefixError}`);
        return;
      }
    }
    previewMutation.mutate();
  };

  const handleValidate = (e: React.FormEvent) => {
    e.preventDefault();
    doValidate();
  };

  const handleRegister = () => {
    createMutation.mutate({
      type,
      value: getSubmitValue(),
      expiresAt: expiresAt || undefined,
      comment: comment.trim() || undefined,
    });
  };

  const handleBack = () => {
    setStep("input");
    setPreviewResult(null);
  };

  // Cmd+Enter / Ctrl+Enter shortcut for primary action
  useCommandEnter(
    step === "input" ? doValidate : handleRegister,
    step === "input"
      ? !previewMutation.isPending && hasInput() && (type === "azure-ai-foundry" || !validateKeyPrefix(type, value))
      : !createMutation.isPending,
  );

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Back link */}
      <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/secrets/keys")}>
        <ArrowLeft className="h-4 w-4" /> Back to Keys
      </Button>

      {/* Step indicator */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className={step === "input" ? "font-semibold text-foreground" : ""}>1. Enter Key</span>
        <ArrowRight className="h-3 w-3" />
        <span className={step === "review" ? "font-semibold text-foreground" : ""}>2. Review & Register</span>
      </div>

      {step === "input" && (
        <Card>
          <CardHeader>
            <CardTitle>Enter Key Details</CardTitle>
            <CardDescription>
              Provide the key type and value. We'll validate it and show detected capabilities before registration.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleValidate} className="space-y-4">
              {/* Type */}
              <div className="space-y-2">
                <Label htmlFor="type">Key Type</Label>
                <Select value={type} onValueChange={(v) => setType(v as KeyType)}>
                  <SelectTrigger>
                    <SelectValue>{KEY_TYPE_LABELS[type]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {KEY_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        <div className="flex items-center gap-2">
                          <span className="shrink-0">{KEY_TYPE_LABELS[t]}</span>
                          <div className="flex flex-wrap gap-1">
                            {KEY_TYPE_EXPECTED_CAPABILITIES[t].map((c) => (
                              <Badge key={c} variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
                                {KEY_CAPABILITY_LABELS[c]}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  The credential format. Capabilities are detected automatically during validation.
                </p>
              </div>

              {/* Instructions */}
              {(() => {
                const info = KEY_INSTRUCTIONS[type];
                return (
                  <div className="rounded-md border bg-muted/50 p-4 space-y-3">
                    <p className="text-sm font-medium">How to create this key</p>
                    <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
                      {info.steps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                    {info.link && (
                      <a
                        href={info.link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                        {info.link.label}
                      </a>
                    )}
                    {info.note && (
                      <p className="text-xs text-muted-foreground italic">{info.note}</p>
                    )}
                  </div>
                );
              })()}

              {/* Value */}
              <div className="space-y-2">
                <Label htmlFor="value">Key Value</Label>
                {type === "github-oauth-cookie-state" ? (
                  <Textarea
                    id="value"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder="Paste JSON auth state blob…"
                    rows={6}
                    className="font-mono text-xs"
                  />
                ) : type === "azure-ai-foundry" ? (
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="foundry-endpoint" className="text-xs font-medium">Endpoint URL</Label>
                      <Input
                        id="foundry-endpoint"
                        type="url"
                        value={foundryEndpoint}
                        onChange={(e) => setFoundryEndpoint(e.target.value)}
                        placeholder="https://<resource>.services.ai.azure.com/models"
                        className="font-mono text-xs"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Base URL of your Azure AI Foundry inference endpoint. Must include the <code>/models</code> path segment (this is the inference data-plane root). No trailing slash.
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="foundry-api-key" className="text-xs font-medium">API Key</Label>
                      <SecretInput
                        id="foundry-api-key"
                        value={foundryApiKey}
                        onChange={(e) => setFoundryApiKey(e.target.value)}
                        placeholder="Paste Foundry resource key…"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="foundry-model" className="text-xs font-medium">
                        Deployment / Model name <span className="text-muted-foreground">(optional)</span>
                      </Label>
                      <Input
                        id="foundry-model"
                        type="text"
                        value={foundryModel}
                        onChange={(e) => setFoundryModel(e.target.value)}
                        placeholder="gpt-4.1"
                        className="font-mono text-xs"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        If set, overrides the API's default <code>LLM_MODEL</code> for this key.
                      </p>
                    </div>
                  </div>
                ) : (
                  <SecretInput
                    id="value"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder="Paste API key…"
                  />
                )}
                <p className="text-xs text-muted-foreground">
                  Will be stored securely in KeyVault. Cannot be retrieved after creation.
                </p>
                {/* Prefix validation warning */}
                {type !== "azure-ai-foundry" && (() => {
                  const warning = validateKeyPrefix(type, value);
                  if (!warning) return null;
                  return (
                    <p className="flex items-center gap-1.5 text-xs text-amber-600">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      Key format doesn't match selected type. {warning}
                    </p>
                  );
                })()}
              </div>

              {/* Expires At */}
              <div className="space-y-2">
                <Label htmlFor="expiresAt">Expires At (optional)</Label>
                <Input
                  id="expiresAt"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
              </div>

              {/* Comment */}
              <div className="space-y-2">
                <Label htmlFor="comment">Comment (optional)</Label>
                <Input
                  id="comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="e.g. John's CI key"
                  maxLength={500}
                />
                <p className="text-xs text-muted-foreground">
                  A short note to help identify this key later.
                </p>
              </div>

              {/* Validate */}
              <Button
                type="submit"
                disabled={previewMutation.isPending || !hasInput() || (type !== "azure-ai-foundry" && !!validateKeyPrefix(type, value))}
                className="gap-1.5"
              >
                {previewMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Validate & Preview
                <ArrowRight className="h-4 w-4" />
                <KbdBadge />
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {step === "review" && previewResult && (
        <Card>
          <CardHeader>
            <CardTitle>Review Detected Capabilities</CardTitle>
            <CardDescription>
              Verify the validation results below before registering the key.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Validation status */}
            <div className="flex items-center gap-3">
              <StatusIcon status={previewResult.status} />
              <div>
                <p className="font-medium capitalize">
                  Validation: {previewResult.status}
                </p>
                {previewResult.error && (
                  <p className="text-sm text-destructive">{previewResult.error}</p>
                )}
              </div>
            </div>

            {previewResult.status !== "valid" && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Validation failed</AlertTitle>
                <AlertDescription>
                  You can still register this key, but it won't be usable until validation passes.
                </AlertDescription>
              </Alert>
            )}

            <Separator />

            {/* Token type */}
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">Key Type</p>
              <p>{KEY_TYPE_LABELS[type]}</p>
            </div>

            {/* Capabilities */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Detected Capabilities</p>
              {(previewResult.capabilities ?? []).length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {previewResult.capabilities!.map((c) => (
                    <Badge key={c} variant="secondary" className="text-sm">
                      {KEY_CAPABILITY_LABELS[c] ?? c}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No capabilities detected</p>
              )}
            </div>

            {/* Scopes (if present) */}
            {previewResult.scopes && previewResult.scopes.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">OAuth Scopes</p>
                <div className="flex flex-wrap gap-1.5">
                  {previewResult.scopes.map((s) => (
                    <Badge key={s} variant="outline" className="text-xs font-mono">
                      {s}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Rate limit (if present) */}
            {previewResult.rateLimit && (
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">Rate Limit</p>
                <p className="text-sm">
                  {previewResult.rateLimit.remaining.toLocaleString()} / {previewResult.rateLimit.limit.toLocaleString()} remaining
                </p>
              </div>
            )}

            {/* Expiry */}
            {expiresAt && (
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">Expires At</p>
                <p className="text-sm">{new Date(expiresAt).toLocaleString()}</p>
              </div>
            )}

            <Separator />

            {/* Actions */}
            <div className="flex items-center gap-3">
              <Button variant="outline" onClick={handleBack} disabled={createMutation.isPending}>
                <ArrowLeft className="h-4 w-4 mr-1.5" />
                Back
              </Button>
              <Button onClick={handleRegister} disabled={createMutation.isPending} className="gap-1.5">
                {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Register Key
                <KbdBadge />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
