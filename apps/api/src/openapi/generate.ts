// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import "../index.js";
import { generateOpenAPIDocument } from "./registry.js";
import { serializeOpenAPIDocument } from "./serialize.js";

const websiteSpecPath = fileURLToPath(
  new URL("../../../../website/src/openapi/scope-openapi.json", import.meta.url),
);
const document = generateOpenAPIDocument();

await writeFile(websiteSpecPath, serializeOpenAPIDocument(document));
console.log(`Wrote OpenAPI specification to ${websiteSpecPath}`);
