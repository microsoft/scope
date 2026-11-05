// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { atifV17Schema } from "./schemas.js";

export { atifV17Schema };
export type AtifV17 = Record<string, unknown> & {
  schema_version: "ATIF-v1.7";
};
