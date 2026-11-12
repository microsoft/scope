// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export type TaxonomySourceType = "builtin" | "user";

export interface TaxonomyPathElementReference {
  path: string;
}

export interface TaxonomyRevisionElementReference {
  ref: string;
}

export type TaxonomyElementReference =
  | TaxonomyPathElementReference
  | TaxonomyRevisionElementReference;

export interface PortableTaxonomyDocument {
  schema_version: "scope/taxonomy/v1";
  id: string;
  version: string;
  surfaces: Array<{
    id: string;
    label: string;
    description?: string;
  }>;
  elements: TaxonomyElementReference[];
}

export interface PortableTaxonomyElementDocument {
  schema_version?: "scope/taxonomy/v1";
  id: string;
  label: string;
  description?: string;
  category_id?: string;
  implementation:
    | { type: "prompt"; prompt: string }
    | { type: "deterministic"; handler: string; config?: unknown };
  preconditions: Record<string, boolean>;
  output: {
    evidence_roles: Record<string, unknown>;
    constraints?: unknown[];
  };
}

export interface TaxonomyDocument {
  _id: string;
  projectId: string;
  id: string;
  name: string;
  description?: string;
  sourceType: TaxonomySourceType;
  revisionCounter: number;
  latestRevisionId?: string;
  latestRevision?: number;
  creator?: string;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}

export interface TaxonomyElementDocument {
  _id: string;
  projectId: string;
  id: string;
  name: string;
  description?: string;
  sourceType: TaxonomySourceType;
  revisionCounter: number;
  latestRevisionId?: string;
  latestRevision?: number;
  creator?: string;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}

export interface TaxonomyRevisionDocument extends PortableTaxonomyDocument {
  _id: string;
  taxonomyId: string;
  projectId: string;
  sourceType: TaxonomySourceType;
  revision: number;
  ref: string;
  contentSha256: string;
  creator?: string;
  createdAt: Date;
}

export interface TaxonomyElementRevisionDocument
  extends PortableTaxonomyElementDocument {
  _id: string;
  elementId: string;
  projectId: string;
  sourceType: TaxonomySourceType;
  revision: number;
  ref: string;
  contentSha256: string;
  creator?: string;
  createdAt: Date;
}

export interface TaxonomyListItem extends TaxonomyDocument {
  ref: string;
  version: string;
  elementCount: number;
}

export interface TaxonomyRevisionSummary {
  _id: string;
  revision: number;
  ref: string;
  version: string;
  elementCount: number;
  contentSha256: string;
  creator?: string;
  createdAt: Date;
  isLatest: boolean;
}

export interface ResolvedTaxonomyElement {
  position: number;
  root: TaxonomyElementDocument;
  revision: TaxonomyElementRevisionDocument;
}

export interface TaxonomyDetail {
  taxonomy: TaxonomyDocument;
  selectedRevision: TaxonomyRevisionDocument;
  revisions: TaxonomyRevisionSummary[];
  elements: ResolvedTaxonomyElement[];
}
