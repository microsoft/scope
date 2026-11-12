// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TAXONOMY_ELEMENT_IDS, TAXONOMY_ELEMENT_METADATA, type TaxonomyElementId } from "@/types";

interface ObservationTaxonomySelectProps {
  value?: TaxonomyElementId;
  onChange: (value: TaxonomyElementId | undefined) => void;
  id?: string;
  label?: string;
}

export function ObservationTaxonomySelect({
  value,
  onChange,
  id,
  label = "Observation dimension",
}: ObservationTaxonomySelectProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-sm font-semibold">{label}</Label>
      <Select
        value={value ?? "__none"}
        onValueChange={(next) => onChange(next === "__none" ? undefined : next as TaxonomyElementId)}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder="Select a dimension" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">Unclassified</SelectItem>
          {TAXONOMY_ELEMENT_IDS.map((taxonomyId) => {
            const metadata = TAXONOMY_ELEMENT_METADATA[taxonomyId];
            return (
              <SelectItem key={taxonomyId} value={taxonomyId}>
                {metadata.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {value ? TAXONOMY_ELEMENT_METADATA[value].description : "Leave unset to group results as unclassified."}
      </p>
    </div>
  );
}
