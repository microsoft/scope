// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { RunsList } from "@/pages/RunsList";
import { RunDetail } from "@/pages/RunDetail";
import { SubmitRun } from "@/pages/SubmitRun";
import { CriteriaList } from "@/pages/CriteriaList";
import { CriterionDetail } from "@/pages/CriterionDetail";
import { CriterionPreviewPanel } from "@/pages/CriterionPreviewPanel";
import { CreateCriterion } from "@/pages/CreateCriterion";
import { CriteriaGraphView } from "@/pages/CriteriaGraphView";
import { Statistics } from "@/pages/Statistics";
import { PromptFeatureList } from "@/pages/PromptFeatureList";
import { PromptFeatureDetail } from "@/pages/PromptFeatureDetail";
import { CreatePromptFeature } from "@/pages/CreatePromptFeature";
import { ReportsList } from "@/pages/ReportsList";
import { ReportDetail } from "@/pages/ReportDetail";
import { ReportPreviewPanel } from "@/pages/ReportPreviewPanel";
import { ReportTemplateList } from "@/pages/ReportTemplateList";
import { ReportTemplateDetail } from "@/pages/ReportTemplateDetail";
import { CreateReportTemplate } from "@/pages/CreateReportTemplate";
import { TokenList } from "@/pages/TokenList";
import { CreateToken } from "@/pages/CreateToken";
import { TokenDetail } from "@/pages/TokenDetail";
import { TokenPreviewPanel } from "@/pages/TokenPreviewPanel";
import { AccountList } from "@/pages/AccountList";
import { CreateAccount } from "@/pages/CreateAccount";
import { AccountDetail } from "@/pages/AccountDetail";
import { AgentList } from "@/pages/AgentList";
import { AgentDetail } from "@/pages/AgentDetail";
import { McpServerList } from "@/pages/McpServerList";
import { CreateMcpServer } from "@/pages/CreateMcpServer";
import { McpServerDetail } from "@/pages/McpServerDetail";
import { McpServerPreviewPanel } from "@/pages/McpServerPreviewPanel";
import { SkillList } from "@/pages/SkillList";
import { SkillDetail } from "@/pages/SkillDetail";
import { CodebaseList } from "@/pages/CodebaseList";
import { CodebaseDetail } from "@/pages/CodebaseDetail";
import { ExtensionList } from "@/pages/ExtensionList";
import { ExtensionDetail } from "@/pages/ExtensionDetail";
import { ExtensionPreviewPanel } from "@/pages/ExtensionPreviewPanel";
import { ProfileList } from "@/pages/ProfileList";
import { ProfileDetail } from "@/pages/ProfileDetail";
import { ProfilePreviewPanel } from "@/pages/ProfilePreviewPanel";
import { CreateProfile } from "@/pages/CreateProfile";
import { NewProfileVersion } from "@/pages/NewProfileVersion";
import { InsightsList } from "@/pages/InsightsList";
import { InsightDetail } from "@/pages/InsightDetail";
import { InsightPreviewPanel } from "@/pages/InsightPreviewPanel";
import { CriteriaMdpView } from "@/pages/CriteriaMdpView";
import { ModelList } from "@/pages/ModelList";
import { ModelDetail } from "@/pages/ModelDetail";
import { TaskPromptList } from "@/pages/TaskPromptList";
import { TaskPromptDetail } from "@/pages/TaskPromptDetail";
import { TaskPromptPreviewPanel } from "@/pages/TaskPromptPreviewPanel";
import { RunPreviewPanel } from "@/pages/RunPreviewPanel";
import { Admin } from "@/pages/Admin";
import { Projects } from "@/pages/Projects";
import { FeatureRoute } from "@/components/FeatureRoute";
import { ProjectGate } from "@/components/ProjectGate";
import { HomeRoute } from "@/components/HomeRoute";
import { useFavicon } from "@/hooks/useFavicon";

export function App() {
  useFavicon();

  return (
    <Routes>
      <Route
        element={<Layout />}
      >
        {/* Root is the unscoped "home": `HomeRoute` clears any active project
            and renders the project picker. Reaching `/` by any means (the MS
            Scope logo, a typed URL, the back button) de-scopes; there is no
            default project, so `/` is the picker, and it forwards to
            `/statistics` only once the user picks a project. */}
        <Route path="/" element={<HomeRoute />} />
        <Route path="/runs" element={<ProjectGate><RunsList /></ProjectGate>}>
          <Route path=":id/preview" element={<RunPreviewPanel />} />
        </Route>
        <Route path="/runs/new" element={<ProjectGate><SubmitRun /></ProjectGate>} />
        <Route path="/runs/:id/:tab?" element={<RunDetail />} />
        <Route path="/reports" element={<ProjectGate><ReportsList /></ProjectGate>}>
          <Route path=":id/preview" element={<ReportPreviewPanel />} />
        </Route>
        <Route path="/reports/templates" element={<ProjectGate><ReportTemplateList /></ProjectGate>} />
        <Route path="/reports/templates/new" element={<ProjectGate><CreateReportTemplate /></ProjectGate>} />
        <Route path="/reports/templates/:id" element={<ReportTemplateDetail />} />
        <Route path="/reports/:id" element={<ReportDetail />} />
        {/* Redirect old /report-templates URLs */}
        <Route path="/report-templates" element={<Navigate to="/reports/templates" replace />} />
        <Route path="/report-templates/:id" element={<Navigate to="/reports/templates" replace />} />
        <Route path="/insights" element={<ProjectGate><InsightsList /></ProjectGate>}>
          <Route path=":id/preview" element={<InsightPreviewPanel />} />
        </Route>
        <Route path="/insights/:id" element={<InsightDetail />} />
        <Route path="/criteria" element={<ProjectGate><CriteriaList /></ProjectGate>}>
          <Route path=":id/preview" element={<CriterionPreviewPanel />} />
        </Route>
        <Route path="/criteria/new" element={<ProjectGate><CreateCriterion /></ProjectGate>} />
        <Route path="/criteria/graph" element={<ProjectGate><CriteriaGraphView /></ProjectGate>} />
        <Route path="/criteria/mdp" element={<ProjectGate><CriteriaMdpView /></ProjectGate>} />
        <Route path="/criteria/:id" element={<CriterionDetail />} />
        <Route path="/prompt-features" element={<ProjectGate><PromptFeatureList /></ProjectGate>}>
          <Route path=":id" element={<PromptFeatureDetail />} />
        </Route>
        <Route path="/prompt-features/new" element={<ProjectGate><CreatePromptFeature /></ProjectGate>} />
        <Route path="/task-prompts" element={<ProjectGate><TaskPromptList /></ProjectGate>}>
          <Route path=":id/preview" element={<TaskPromptPreviewPanel />} />
        </Route>
        <Route path="/task-prompts/:id" element={<TaskPromptDetail />} />
        <Route path="/statistics" element={<ProjectGate><Statistics /></ProjectGate>} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/secrets" element={<Navigate to="/secrets/keys" replace />} />
        <Route path="/secrets/keys" element={<FeatureRoute featureKey="tokens"><TokenList /></FeatureRoute>}>
          <Route path=":id/preview" element={<FeatureRoute featureKey="tokens"><TokenPreviewPanel /></FeatureRoute>} />
        </Route>
        <Route path="/secrets/keys/new" element={<FeatureRoute featureKey="tokens"><CreateToken /></FeatureRoute>} />
        <Route path="/secrets/keys/:id" element={<FeatureRoute featureKey="tokens"><TokenDetail /></FeatureRoute>} />
        <Route path="/secrets/accounts" element={<FeatureRoute featureKey="tokens"><AccountList /></FeatureRoute>} />
        <Route path="/secrets/accounts/new" element={<FeatureRoute featureKey="tokens"><CreateAccount /></FeatureRoute>} />
        <Route path="/secrets/accounts/:id" element={<FeatureRoute featureKey="tokens"><AccountDetail /></FeatureRoute>} />
        <Route path="/agents" element={<FeatureRoute featureKey="agents"><AgentList /></FeatureRoute>}>
          <Route path=":id" element={<FeatureRoute featureKey="agents"><AgentDetail /></FeatureRoute>} />
        </Route>
        <Route path="/models" element={<FeatureRoute featureKey="models"><ModelList /></FeatureRoute>}>
          <Route path=":id" element={<FeatureRoute featureKey="models"><ModelDetail /></FeatureRoute>} />
        </Route>
        <Route path="/mcp-servers" element={<FeatureRoute featureKey="mcp"><ProjectGate><McpServerList /></ProjectGate></FeatureRoute>}>
          <Route path=":slug/preview" element={<FeatureRoute featureKey="mcp"><McpServerPreviewPanel /></FeatureRoute>} />
        </Route>
        <Route path="/mcp-servers/new" element={<FeatureRoute featureKey="mcp"><ProjectGate><CreateMcpServer /></ProjectGate></FeatureRoute>} />
        <Route path="/mcp-servers/:slug" element={<FeatureRoute featureKey="mcp"><McpServerDetail /></FeatureRoute>} />
        <Route path="/skills" element={<FeatureRoute featureKey="skills"><ProjectGate><SkillList /></ProjectGate></FeatureRoute>} />
        <Route path="/skills/*" element={<FeatureRoute featureKey="skills"><SkillDetail /></FeatureRoute>} />
        <Route path="/codebases" element={<ProjectGate><CodebaseList /></ProjectGate>} />
        <Route path="/codebases/:id" element={<CodebaseDetail />} />
        <Route path="/codebases/:id/revisions/:revisionId" element={<CodebaseDetail />} />
        <Route path="/extensions" element={<FeatureRoute featureKey="extensions"><ProjectGate><ExtensionList /></ProjectGate></FeatureRoute>}>
          <Route path=":id/preview" element={<FeatureRoute featureKey="extensions"><ExtensionPreviewPanel /></FeatureRoute>} />
        </Route>
        <Route path="/extensions/:id" element={<FeatureRoute featureKey="extensions"><ExtensionDetail /></FeatureRoute>} />
        <Route path="/profiles" element={<FeatureRoute featureKey="profiles"><ProjectGate><ProfileList /></ProjectGate></FeatureRoute>}>
          <Route path=":profileId/preview" element={<FeatureRoute featureKey="profiles"><ProfilePreviewPanel /></FeatureRoute>} />
        </Route>
        <Route path="/profiles/new" element={<FeatureRoute featureKey="profiles"><ProjectGate><CreateProfile /></ProjectGate></FeatureRoute>} />
        <Route path="/profiles/:profileId" element={<FeatureRoute featureKey="profiles"><ProfileDetail /></FeatureRoute>} />
        <Route path="/profiles/:profileId/v/:version" element={<FeatureRoute featureKey="profiles"><ProfileDetail /></FeatureRoute>} />
        <Route path="/profiles/:profileId/new-version" element={<FeatureRoute featureKey="profiles"><ProjectGate><NewProfileVersion /></ProjectGate></FeatureRoute>} />
        <Route path="/admin" element={<Admin />} />
      </Route>
    </Routes>
  );
}
