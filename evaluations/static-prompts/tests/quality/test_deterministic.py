from static_prompt_evals.quality.data import normalize_rows
from static_prompt_evals.quality.deterministic import evaluate_deterministic


def _observations(cases, generated, family_config, samples=1):
    rows = normalize_rows(cases, generated, expected_samples=samples)
    return evaluate_deterministic(rows, {cases[0]["family"]: family_config})


def test_feature_extraction_metrics_and_candidate_validation() -> None:
    cases = [
        {
            "id": "feature-case",
            "family": "prompt-feature-extraction",
            "input": {"features": [{"id": "typescript"}, {"id": "testing"}]},
            "expected": {"featureIds": ["typescript", "testing"]},
        }
    ]
    generated = [
        {
            "id": "feature-case",
            "sampleIndex": 0,
            "output": {"featureIds": ["typescript", "invented"]},
        }
    ]
    observations = _observations(
        cases,
        generated,
        {
            "deterministic": [
                {
                    "check": "references_candidates",
                    "metric": "candidate_references",
                    "referencePaths": ["output.featureIds"],
                    "candidatePaths": ["input.features"],
                },
                {
                    "check": "label_metrics",
                    "predictedPaths": ["output.featureIds"],
                    "expectedPaths": ["expected.featureIds"],
                    "thresholds": {
                        "feature_precision": 1,
                        "feature_recall": 1,
                        "feature_f1": 1,
                        "feature_exact_match": 1,
                    },
                },
            ]
        },
    )
    by_name = {observation.evaluator: observation for observation in observations}

    assert by_name["candidate_references"].passed is False
    assert by_name["feature_precision"].score == 0.5
    assert by_name["feature_recall"].score == 0.5
    assert by_name["feature_exact_match"].passed is False


def test_feedback_checks_forbidden_terms_questions_and_descendants() -> None:
    cases = [
        {
            "id": "feedback-case",
            "family": "developer-feedback",
            "input": {"descendantPrompts": ["Add comprehensive retry telemetry"]},
        }
    ]
    generated = [
        {
            "id": "feedback-case",
            "sampleIndex": 0,
            "output": {
                "feedback": (
                    "Can you satisfy the next criterion? "
                    "Add comprehensive retry telemetry."
                )
            },
        }
    ]
    observations = _observations(
        cases,
        generated,
        {
            "deterministic": [
                {
                    "check": "forbidden_terms",
                    "metric": "forbidden_language",
                    "terms": ["criterion", "evaluation"],
                },
                {"check": "no_questions"},
                {
                    "check": "descendant_leakage",
                    "descendantPaths": ["input.descendantPrompts"],
                },
            ]
        },
    )

    assert {item.evaluator for item in observations if item.passed is False} == {
        "forbidden_language",
        "no_questions",
        "descendant_leakage_check",
    }


def test_sample_diversity_requires_materially_distinct_repetitions() -> None:
    cases = [{"id": "task-case", "family": "task-prompt-generation"}]
    generated = [
        {
            "id": "task-case",
            "sampleIndex": sample,
            "output": {"prompt": "Build the same exact service"},
        }
        for sample in range(3)
    ]
    observations = _observations(
        cases,
        generated,
        {
            "deterministic": [
                {
                    "check": "sample_diversity",
                    "minUniqueRatio": 0.67,
                    "maxPairSimilarity": 0.95,
                }
            ]
        },
        samples=3,
    )

    assert len(observations) == 1
    assert observations[0].passed is False
    assert observations[0].details["uniqueRatio"] == 1 / 3


def test_missing_generated_sample_is_infrastructure_error() -> None:
    rows = normalize_rows(
        [{"id": "case", "family": "criteria-authoring"}],
        [{"id": "case", "sampleIndex": 0, "output": {"prompt": "Do it"}}],
        expected_samples=2,
    )

    assert rows[1].infrastructure_error is True
    assert "did not emit" in (rows[1].generation_error or "")


def test_adapter_contract_messages_tools_and_expected_label_are_normalized() -> None:
    rows = normalize_rows(
        [
            {
                "id": "case",
                "family": "criteria-authoring",
                "input": {"behavior": "Use both evidence sources"},
                "expected": {"evidenceSource": "both"},
                "provenance": {"kind": "integration"},
            }
        ],
        [
            {
                "caseId": "case",
                "sampleIndex": 0,
                "status": "ok",
                "request": {
                    "messages": [{"role": "user", "content": "Author it"}],
                    "tools": [{"name": "read_file"}],
                },
                "output": {"id": "uses_both", "prompt": "Use both."},
            }
        ],
        expected_samples=1,
    )

    assert rows[0].query == "Use both evidence sources"
    assert rows[0].query_messages[0]["content"] == [{"type": "text", "text": "Author it"}]
    assert rows[0].tool_definitions[0]["name"] == "read_file"
    assert rows[0].expected_labels["criteria_evidence_source"] == "both"
    assert rows[0].source_category == "integration"


def test_feature_result_coverage_requires_every_feature_once() -> None:
    observations = _observations(
        [
            {
                "id": "feature-case",
                "family": "prompt-feature-extraction",
                "input": {"features": [{"id": "one"}, {"id": "two"}]},
            }
        ],
        [
            {
                "id": "feature-case",
                "sampleIndex": 0,
                "output": {
                    "results": [
                        {"featureId": "one", "detected": True, "evaluated": True},
                        {"featureId": "one", "detected": False, "evaluated": True},
                    ]
                },
            }
        ],
        {
            "deterministic": [
                {
                    "check": "feature_result_coverage",
                    "actualPaths": ["output.results"],
                    "expectedPaths": ["input.features"],
                }
            ]
        },
    )

    assert observations[0].passed is False
