// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useNavigate } from "react-router-dom";
import { ArrowLeft, Boxes } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ResourceCreateForm } from "@/components/ResourceCreateForm";

export function CreateResource() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/resources")}><ArrowLeft className="h-4 w-4" /> Back to Resources</Button>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Boxes className="h-5 w-5" /> Create Resource</CardTitle>
          <CardDescription>
            Define the first immutable lifecycle revision. Future lifecycle edits create additional revisions instead of mutating this one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResourceCreateForm onCreated={(resource) => navigate(`/resources/${resource.slug}`)} />
        </CardContent>
      </Card>
    </div>
  );
}
