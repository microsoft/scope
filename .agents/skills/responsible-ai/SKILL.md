---
name: responsible-ai
description: >
  Routes new AI/ML or generative-AI features to Microsoft's Responsible AI
  Standard and the OneRAI intake (onerai.microsoft.com) / RAI Champ — a process
  gate, not local automation; do not self-certify.
  Trigger: adding/modifying an AI feature, or integrating a model, provider,
  prompt, or agent.
  Not for: non-AI changes, or using AI dev tools that aren't shipped features.
metadata:
  version: "1.0.0"
---

# Responsible AI

New or materially changed AI/ML and generative-AI capabilities must clear
Microsoft's Responsible AI (RAI) process before release. This is a **process and
attestation gate — there is no local script or CI check to run.**

**Do not paraphrase, summarize, or hardcode RAI policy into this skill.** The
Standard and the intake questions evolve; the authoritative sources own them.

## When this applies

- Adding or significantly changing an AI/ML or generative-AI feature.
- Integrating a new model, provider, prompt, agent, or evaluation of model output.
- Any functionality that generates, classifies, ranks, or transforms content
  using a model.

## Source of truth

- **Microsoft Responsible AI Standard** — the governing policy for RAI
  requirements and impact assessment.
- **OneRAI intake:** **onerai.microsoft.com** — file or refresh the intake for the
  feature.
- **The team's RAI Champ** — the human owner to loop in for guidance and sign-off.

## What to do

1. For a new or changed AI feature, complete or refresh the **OneRAI intake** and
   follow the **Responsible AI Standard**.
2. Loop in the **RAI Champ** early — before shipping, not after.
3. Track the RAI review as a required release gate alongside the other OSS
   compliance items.

## On uncertainty

If it is unclear whether a change triggers RAI review, or an intake question is
ambiguous, **contact the RAI Champ / file a OneRAI intake and ask — do not
self-certify or skip it.**
