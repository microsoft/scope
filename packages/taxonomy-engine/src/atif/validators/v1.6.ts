// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { atifV16Schema } from "./schemas.js";

export { atifV16Schema };
export type AtifV16 = z.infer<typeof atifV16Schema>;
