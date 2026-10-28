// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  atifV18Schema,
  canonicalAtifV18Schema,
  contentPartV18Schema,
} from "./schemas.js";

export {
  atifV18Schema,
  canonicalAtifV18Schema,
  contentPartV18Schema,
};
export const contentPartSchema = contentPartV18Schema;
export type AtifV18 = Record<string, unknown> & {
  schema_version: "ATIF-v1.8";
};
