# Camera VQA / Atlas Diagnostics

This tool turns `camera.mcap` files into `*.camera.vqa.json` sidecars for
ad-topology's Camera View. It is designed as a production-oriented validation
boundary for the real Atlas + `vlm_adapter` + cosmos/Qwen runtime, not as a
replacement encoder.

## Architecture

```text
camera.mcap
  -> MCAP frame extractor
  -> 12-camera Atlas input metadata
  -> runtime adapter (external / http / precomputed / fixture)
  -> diagnostics + structured VQA answer
  -> *.camera.vqa.json
  -> Camera View VQA panel + badges
```

## Runtime Modes

| mode | purpose | production use |
|---|---|---|
| `external` | run a model-team executable with JSON input/output files | yes |
| `http` | call a model service endpoint | yes |
| `precomputed` | read model-team offline results for alignment | yes for validation |
| `fixture` | deterministic fake output for UI/tests | no |

The fixture runtime is always marked:

```json
{
  "non_production": true
}
```

## Expected Real Runtime Contract

A real runtime should return:

```json
{
  "runtime": {
    "name": "atlas_cosmos7b",
    "version": "2026-xx",
    "mode": "external"
  },
  "diagnostics": {
    "backbone": {
      "name": "atlas_backbone",
      "exposed": true,
      "latency_ms": 40.8,
      "output_shape": [1, 12, 256, 1024],
      "dtype": "float16",
      "mean": 0.002,
      "std": 0.91,
      "l2_norm": 512.4,
      "nan_count": 0,
      "inf_count": 0
    },
    "vlm_adapter": {
      "exposed": true,
      "latency_ms": 1.2,
      "output_shape": [1, 64, 3584],
      "token_count": 64,
      "dtype": "float16",
      "mean": -0.001,
      "std": 0.77,
      "l2_norm": 408.2,
      "nan_count": 0,
      "inf_count": 0
    },
    "perceiver": {
      "name": "flamingo_perceiver_resampler",
      "exposed": true,
      "latency_ms": 1.1,
      "num_queries": 64,
      "layers": 4,
      "output_shape": [1, 64, 3584],
      "attention_entropy": 2.1,
      "per_camera_attention": {
        "front_middle_0": 0.18,
        "front_left_1": 0.11,
        "front_left_dark_11": 0.08
      }
    },
    "decoder": {
      "name": "cosmos7B_qwen2_5_decoder",
      "latency_ms": 6.3,
      "prompt_tokens": 23,
      "output_tokens": 7,
      "schema_valid": true
    }
  },
  "answer": {
    "raw": "{}",
    "parsed": {
      "camera_states": {
        "front_left_1": {
          "visibility_state": "wet",
          "severity": "medium",
          "confidence": 0.84
        }
      },
      "function_impact": {
        "LCC": {
          "predicted": "degrade",
          "actual": "unknown",
          "confidence": 0.72,
          "basis": ["front_left_1=wet"],
          "evidence_type": "dependency_matrix"
        }
      }
    },
    "schema_errors": []
  }
}
```

If an internal tensor is not exposed, say that explicitly:

```json
{
  "exposed": false,
  "reason": "runtime_does_not_export_vlm_tokens"
}
```

## Flamingo-Style Perceiver Resampler Diagnostics

For the Atlas -> Qwen/cosmos bridge, the preferred design is inspired by
Flamingo's Perceiver Resampler: many multi-camera visual tokens are compressed
into a fixed number of Qwen-compatible visual prefix tokens.

The runtime should expose:

- `num_queries`: expected `64` for the current contract
- `layers`: number of Perceiver cross-attention layers, usually `4`
- `output_shape`: expected `[B, 64, D_qwen]`
- `attention_entropy`: high-level sanity metric for query attention spread
- `per_camera_attention`: normalized contribution by camera id; this helps
  detect camera-order mistakes, missing-camera handling issues, or one camera
  dominating all queries unexpectedly

This diagnostics block is optional for early runtimes, but if the runtime does
not expose it, return:

```json
{
  "exposed": false,
  "reason": "runtime_does_not_export_perceiver_attention"
}
```

## CLI

```bash
PYTHONPATH=. python3 tools/camera_vqa/detect.py \
  --mcap /home/caros/workspace/mcap_file/20260508193330838.record.00000.camera.mcap \
  --runtime fixture \
  --sample-interval-sec 10 \
  --max-samples 3
```

The default output path for `foo.camera.mcap` is:

```text
foo.camera.vqa.json
```

## External Runtime

```bash
PYTHONPATH=. python3 tools/camera_vqa/detect.py \
  --mcap /path/to/foo.camera.mcap \
  --runtime external \
  --runtime-command /path/to/atlas_vqa_runtime
```

The command receives:

```text
atlas_vqa_runtime <input_json> <output_json>
```

The input JSON contains `mcap_path`, timestamp, camera mask/order, and
questions. The output JSON should follow the runtime contract above.

## Tests

```bash
PYTHONPATH=. python3 -m unittest discover -s tools/camera_vqa/tests -v
node --check server/index.js
```

## Product Semantics

`function_impact.predicted` is a risk/dependency-matrix prediction. It is not a
claim that the vehicle feature is actually off. Real feature state must come
from FSM/alarm/planning topics and is represented separately as
`function_impact.actual`.
