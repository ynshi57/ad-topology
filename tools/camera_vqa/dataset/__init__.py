"""Dataset helpers for trainable Camera VQA models."""

STATE_LABELS = [
    "clean",
    "wet",
    "blocked",
    "blur",
    "dark",
    "saturate",
    "frozen",
    "unknown",
]

SEVERITY_LABELS = ["none", "low", "medium", "high", "unknown"]

STATE_TO_ID = {name: i for i, name in enumerate(STATE_LABELS)}
ID_TO_STATE = {i: name for name, i in STATE_TO_ID.items()}
SEVERITY_TO_ID = {name: i for i, name in enumerate(SEVERITY_LABELS)}
ID_TO_SEVERITY = {i: name for name, i in SEVERITY_TO_ID.items()}
