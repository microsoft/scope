// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { isSharedRunPage } from "@/lib/public-run-api";
import "./index.css";

// Public links must not import or initialize MSAL or the private provider tree.
export const bootstrapped = isSharedRunPage(window.location.pathname)
  ? import("./public-main").then(({ mountPublicApp }) => mountPublicApp())
  : import("./private-main").then(({ mountPrivateApp }) => mountPrivateApp());
