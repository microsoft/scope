// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { describe, it, afterEach } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";

import * as alert from "./alert.stories";
import * as alertDialog from "./alert-dialog.stories";
import * as checkbox from "./checkbox.stories";
import * as dialog from "./dialog.stories";
import * as dropdownMenu from "./dropdown-menu.stories";
import * as label from "./label.stories";
import * as popover from "./popover.stories";
import * as scrollArea from "./scroll-area.stories";
import * as select from "./select.stories";
import * as separator from "./separator.stories";
import * as sheet from "./sheet.stories";
import * as skeleton from "./skeleton.stories";
import * as sw from "./switch.stories";
import * as table from "./table.stories";
import * as tabs from "./tabs.stories";
import * as textarea from "./textarea.stories";
import * as tooltip from "./tooltip.stories";
import * as sonner from "./sonner.stories";
import * as runsIterationFilter from "../../pages/RunsList.stories";

const modules: Record<string, Record<string, unknown>> = {
  alert, alertDialog, checkbox, dialog, dropdownMenu, label, popover, scrollArea,
  select, separator, sheet, skeleton, switch: sw, table, tabs, textarea,
  tooltip, sonner, runsIterationFilter,
};

afterEach(() => cleanup());

for (const [name, mod] of Object.entries(modules)) {
  describe(name, () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const composed = composeStories(mod as any);
    for (const [storyName, Story] of Object.entries(composed)) {
      it(`${storyName} renders and play passes`, async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const S = Story as any;
        const { container } = render(<S />);
        // The story play functions only depend on `canvas` (userEvent/screen/expect
        // are imported directly in the story files). Invoke the raw play with a
        // canvas bound to the rendered container to avoid needing the vitest addon.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = (mod as any)[storyName];
        if (raw?.play) {
          await raw.play({ canvas: within(container), canvasElement: container });
        }
      });
    }
  });
}
