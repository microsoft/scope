// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  TAXONOMY_ELEMENT_IDS,
  TaxonomyElementId,
  isTaxonomyElementId,
} from "../types/types.js";

/** Re-export the hard-coded taxonomy constants from the shared barrel. */
export { TAXONOMY_ELEMENT_IDS, isTaxonomyElementId };
export type { TaxonomyElementId };

/** Static, human-facing metadata for a taxonomy element. */
export interface TaxonomyElementMetadata {
  id: TaxonomyElementId;
  label: string;
  description: string;
}

/**
 * Hard-coded metadata for every observation taxonomy element, keyed by id —
 * the three quality dimensions from the R&A Readout design. See issue #1156.
 */
export const TAXONOMY_ELEMENT_METADATA: Record<TaxonomyElementId, TaxonomyElementMetadata> = {
  "dimension:idiomatic-use": {
    id: "dimension:idiomatic-use",
    label: "Idiomatic use",
    description:
      "Did the agent follow the product's recommended patterns and best practices " +
      "(quality of how the product is used, not whether it is used at all)?",
  },
  "dimension:dependency-currency": {
    id: "dimension:dependency-currency",
    label: "Dependency currency",
    description: "Did the agent use current versions, packages, and namespaces?",
  },
  "dimension:configuration-correctness": {
    id: "dimension:configuration-correctness",
    label: "Configuration correctness",
    description: "Are auth, connection, environment, and deployment settings configured properly?",
  },
};
