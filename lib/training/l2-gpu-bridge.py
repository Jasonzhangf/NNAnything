#!/usr/bin/env python3
"""Batched tensor backend bridge for the experimental L2 four-head MLP.

Protocol: one JSON request line on stdin, then a stream of newline-delimited
JSON events on stdout. Every event is flushed immediately, so training progress
is visible while it happens. The stream ends with a `final` event or an `error`
event.

Event kinds (amendment 3.4):

  {"type":"phase","phase":"initialize","stageStatus":"start"|"end"|"failed", ...}
  {"type":"step","phase":"update","completedUpdates":N, ...}
  {"type":"checkpoint","step":N,"path":"...","previousPath":"...", ...}
  {"type":"error","error":{"kind":"...","message":"...","phase":"..."}}
  {"type":"final","ok":true, ...}

Phases (amendment 3.4): initialize, data_prepare, device_load, first_compute,
update, save_checkpoint, evaluate, reload, complete, cancelled.

Devices: "cpu" -> torch CPU tensors, "mps" -> torch MPS tensors. There is no
fallback: an unsupported device or unusable GPU runtime fails loudly.

Checkpoints follow `nnanything.l2.mlp.checkpoint.v1` (amendment 3.2). A write
goes to a temporary file, is flushed and fsynced, the previously committed
record is rotated to `<path>.prev`, and the temporary file is moved into place
with an atomic replace. Only committed checkpoints can be restored.

Step atomicity (amendment 3.1 clause 2): every trained head's candidate
parameters are computed and validated finite before any of them is committed. A
failure mid-step leaves the committed parameters at the previous complete step.
"""

import json
import os
import signal
import sys
import tempfile
import time

CHECKPOINT_SCHEMA = "nnanything.l2.mlp.checkpoint.v1"
HEAD_ORDER = ("R", "D", "E", "A")

# Set by SIGINT/SIGTERM. Checked at a step boundary so a controlled cancel always
# lands on a complete update, never mid-update.
CANCEL_REQUESTED = {"value": False, "signal": None}

# The owning bridge run registers a failure sink here so that an unhandled
# exception outside `main()` can still report through `fail_training` and save
# the last complete boundary. It holds the committed parameters, step count and
# persist() of the active run; when absent (no active run), the outer handler
# falls back to the plain internal error.
FAILURE_SINK = [None]


def write_event(payload):
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write("\n")
    sys.stdout.flush()


def finish(payload):
    write_event(payload)
    sys.exit(0)


def fail(kind, message, phase, **extra):
    error = {"kind": kind, "message": message, "phase": phase}
    error.update(extra)
    finish({"type": "error", "error": error})


def install_signal_handlers():
    def handler(signum, _frame):
        CANCEL_REQUESTED["value"] = True
        CANCEL_REQUESTED["signal"] = signal.Signals(signum).name

    for candidate in ("SIGINT", "SIGTERM"):
        number = getattr(signal, candidate, None)
        if number is not None:
            signal.signal(number, handler)


def atomic_write_json(path, payload, previous_path=None):
    """Write a complete file, then move it into place atomically.

    The last committed record is rotated aside before the replace, so a failed or
    partial write can never destroy the checkpoint that was already usable.
    """
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf8", dir=directory, prefix=".l2-checkpoint-", suffix=".tmp", delete=False
    )
    temporary_path = handle.name
    try:
        handle.write(json.dumps(payload, indent=2))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    finally:
        handle.close()
    if previous_path is not None and os.path.exists(path):
        with open(path, "rb") as source:
            previous = source.read()
        previous_handle = tempfile.NamedTemporaryFile(
            mode="wb", dir=directory, prefix=".l2-checkpoint-", suffix=".prev.tmp", delete=False
        )
        try:
            previous_handle.write(previous)
            previous_handle.flush()
            os.fsync(previous_handle.fileno())
        finally:
            previous_handle.close()
        os.replace(previous_handle.name, previous_path)
    os.replace(temporary_path, path)


def read_checkpoint(path):
    with open(path, "r", encoding="utf8") as handle:
        return json.load(handle)


def step_stats(durations):
    if not durations:
        return {
            "count": 0,
            "meanStepMs": None,
            "p50StepMs": None,
            "p95StepMs": None,
            "minStepMs": None,
            "maxStepMs": None,
        }
    ordered = sorted(durations)

    def percentile(fraction):
        if len(ordered) == 1:
            return ordered[0]
        return ordered[int(round(fraction * (len(ordered) - 1)))]

    return {
        "count": len(durations),
        "meanStepMs": sum(durations) / len(durations),
        "p50StepMs": percentile(0.5),
        "p95StepMs": percentile(0.95),
        "minStepMs": ordered[0],
        "maxStepMs": ordered[-1],
    }


def main():
    started = time.monotonic()
    install_signal_handlers()

    line = sys.stdin.readline()
    if line.strip() == "":
        fail("protocol", "L2 backend bridge received an empty request", "initialize")
    try:
        request = json.loads(line)
    except Exception as error:  # noqa: BLE001 - the bridge must report, not crash
        fail("protocol", f"L2 backend bridge received invalid JSON: {error}", "initialize")

    op = request.get("op", "evaluate")
    if op not in ("probe", "evaluate", "fit"):
        fail("protocol", f"L2 backend bridge received unsupported op {op!r}", "initialize")

    run_id = request.get("runId") or f"l2-fit-{int(time.time() * 1000)}"
    timings = {
        "deviceLoadMs": 0,
        "dataPrepareMs": 0,
        "firstComputeMs": 0,
        "warmTrainingMs": 0,
        "checkpointWriteMs": 0,
        "checkpointWriteCount": 0,
        "evaluationMs": 0,
        "reloadMs": 0,
        "totalMs": 0,
    }
    epochs = int(request.get("epochs", 0))
    learning_rate = float(request.get("learningRate", 0.0))
    checkpoint_path = request.get("checkpointPath")
    previous_checkpoint_path = f"{checkpoint_path}.prev" if checkpoint_path else None
    checkpoint_every = int(request.get("checkpointEverySteps") or 0)
    resume = bool(request.get("resume", False))
    data_ref = request.get("dataRef")
    recipe_ref = request.get("recipeRef")
    trained_names = [str(name) for name in request.get("trainedHeads") or []]

    trajectory = []
    completed_updates = 0
    epoch_zero = None
    last_persisted_step = None
    step_durations = []
    device = None
    # The most recent checkpoint save failure, or None when the last save
    # succeeded. Mutable so the training-failure path can report it separately.
    LAST_SAVE_ERROR = [None]

    def emit(state, phase, stage_status=None, **extra):
        event = {
            "type": "phase",
            "runId": run_id,
            "state": state,
            "phase": phase,
            "trainedHeads": trained_names,
            "completedUpdates": completed_updates,
            "totalUpdates": epochs,
            "elapsedMs": int((time.monotonic() - started) * 1000),
            "lastPersistedStep": last_persisted_step,
            "device": str(device) if device is not None else None,
        }
        if stage_status is not None:
            event["stageStatus"] = stage_status
        event.update(extra)
        write_event(event)

    def eta_ms():
        if not step_durations or completed_updates <= 0:
            return None
        mean_step = sum(step_durations) / len(step_durations)
        return int(mean_step * max(epochs - completed_updates, 0))

    emit("init", "initialize", "start")
    emit("init", "initialize", "end")

    # ---- device_load -------------------------------------------------------
    device_load_started = time.monotonic()
    emit("init", "device_load", "start")
    try:
        import torch
    except Exception as error:  # noqa: BLE001 - a missing runtime is a real failure
        fail("device", f"L2 GPU backend unavailable: cannot import torch: {error}", "device_load")

    device_name = request.get("device", "cpu")
    if device_name == "mps":
        if not torch.backends.mps.is_built():
            fail("device", "L2 GPU backend unavailable: torch was built without MPS support", "device_load")
        if not torch.backends.mps.is_available():
            fail("device", "L2 GPU backend unavailable: MPS device is not available", "device_load")
    elif device_name != "cpu":
        fail("device", f"L2 backend bridge received unsupported device {device_name!r}", "device_load")
    device = torch.device(device_name)

    # Real device self check: allocate, multiply, synchronize, read finite values
    # back. An import or a capability flag alone is not evidence of a working
    # device.
    left = torch.ones((2, 2), dtype=torch.float32, device=device)
    right = torch.full((2, 2), 2.0, dtype=torch.float32, device=device)
    product = left @ right
    if device_name == "mps":
        torch.mps.synchronize()
    self_check = product.cpu().tolist()
    if not all(abs(value - 4.0) < 1e-6 for row in self_check for value in row):
        fail("device", "L2 GPU backend unavailable: device self check returned wrong values", "device_load")
    timings["deviceLoadMs"] = int((time.monotonic() - device_load_started) * 1000)
    emit(
        "init",
        "device_load",
        "end",
        phaseMs=timings["deviceLoadMs"],
        torch=torch.__version__,
        selfCheck=self_check,
    )

    if op == "probe":
        timings["totalMs"] = int((time.monotonic() - started) * 1000)
        finish(
            {
                "type": "final",
                "ok": True,
                "op": "probe",
                "runId": run_id,
                "device": str(device),
                "torch": torch.__version__,
                "selfCheck": self_check,
                "timings": timings,
            }
        )

    # ---- data_prepare ------------------------------------------------------
    data_prepare_started = time.monotonic()
    emit("init", "data_prepare", "start")
    specs = request.get("heads") or []
    if not specs:
        fail("protocol", "L2 backend bridge received no heads", "data_prepare")
    if not trained_names:
        fail("protocol", "L2 backend bridge received no trained heads", "data_prepare")

    heads = []
    structure = {}
    for spec in specs:
        name = str(spec["name"])
        declared = spec.get("structure") or {}
        declared_features = [str(item) for item in declared.get("features") or []]
        declared_labels = [str(item) for item in declared.get("labels") or []]
        declared_hidden = [int(item) for item in declared.get("hidden") or []]
        if not declared_features:
            fail("protocol", f"L2 backend bridge head {name} has no declared feature names", "data_prepare")
        if not declared_labels:
            fail("protocol", f"L2 backend bridge head {name} has no declared label names", "data_prepare")
        if len(declared_hidden) != 2:
            fail("protocol", f"L2 backend bridge head {name} has no declared hidden sizes", "data_prepare")
        width = len(declared_features)
        labels = len(declared_labels)
        hidden_one, hidden_two = declared_hidden[0], declared_hidden[1]
        flat = spec["parameters"]
        cursor = 0

        def take(count, shape):
            nonlocal cursor
            block = flat[cursor:cursor + count]
            cursor += count
            return torch.tensor(block, dtype=torch.float32, device=device).reshape(shape).clone().requires_grad_(True)

        parameters = [
            take(hidden_one * width, (hidden_one, width)),            # W1
            take(hidden_one, (hidden_one,)),                          # b1
            take(hidden_two * hidden_one, (hidden_two, hidden_one)),   # W2
            take(hidden_two, (hidden_two,)),                          # b2
            take(labels * hidden_two, (labels, hidden_two)),           # W3
            take(labels, (labels,)),                                  # b3
        ]
        if cursor != len(flat):
            fail(
                "protocol",
                f"L2 backend bridge head {name} has {len(flat)} parameters but the declared structure needs {cursor}",
                "data_prepare",
            )
        structure[name] = {
            "features": declared_features,
            "labels": declared_labels,
            "hidden": [hidden_one, hidden_two],
        }
        entry = {
            "name": name,
            "kind": "train" if name in trained_names else "frozen",
            "labels": labels,
            "allowed": None,
            "weights": None,
            "rowCount": 0,
            "parameters": parameters,
        }
        if entry["kind"] == "train":
            rows = spec["features"]
            allowed_mask = torch.zeros((len(spec["allowed"]), labels), dtype=torch.float32, device=device)
            for row, allowed in enumerate(spec["allowed"]):
                for index in allowed:
                    allowed_mask[row, int(index)] = 1.0
            entry["features"] = torch.tensor(rows, dtype=torch.float32, device=device).reshape(len(rows), width)
            entry["allowed"] = allowed_mask
            entry["weights"] = torch.tensor(spec["weights"], dtype=torch.float32, device=device)
            entry["rowCount"] = int(spec["rowCount"])
        heads.append(entry)

    missing = [name for name in trained_names if name not in structure]
    if missing:
        fail("protocol", f"L2 backend bridge is missing declared trained heads {missing}", "data_prepare")
    trained_heads = [head for head in heads if head["kind"] == "train"]
    active_weight = 1.0 / len(trained_heads)
    timings["dataPrepareMs"] = int((time.monotonic() - data_prepare_started) * 1000)
    emit(
        "init",
        "data_prepare",
        "end",
        phaseMs=timings["dataPrepareMs"],
        rawRowCount={head["name"]: int(head["rowCount"]) for head in trained_heads},
        uniqueRowCount={head["name"]: int(head["features"].shape[0]) for head in trained_heads},
    )

    def parameter_values():
        values = {}
        for name in HEAD_ORDER:
            for head in heads:
                if head["name"] == name:
                    flat = []
                    for parameter in head["parameters"]:
                        flat.extend(float(value) for value in parameter.reshape(-1).tolist())
                    values[name] = flat
                    break
            else:
                values[name] = []
        return values

    def load_parameters(stored):
        for head in heads:
            flat = stored.get(head["name"])
            if flat is None:
                fail(
                    "resume",
                    f"L2 checkpoint has no parameters for head {head['name']}",
                    "reload",
                )
            expected = int(sum(int(parameter.numel()) for parameter in head["parameters"]))
            if len(flat) != expected:
                fail(
                    "resume",
                    f"L2 checkpoint head {head['name']} has {len(flat)} parameters, expected {expected}",
                    "reload",
                )
            cursor = 0
            with torch.no_grad():
                for parameter in head["parameters"]:
                    count = int(parameter.numel())
                    block = torch.tensor(flat[cursor:cursor + count], dtype=torch.float32, device=device)
                    cursor += count
                    parameter.copy_(block.reshape(parameter.shape))

    def evaluate(collect_logits=False):
        """Forward all trained heads on one batch.

        Returns per-head loss, the weighted mean loss, per-head correct counts,
        analytic gradients, whether any ReLU activation survived, and optionally
        the logits.
        """
        losses = {}
        gradient_by_head = {}
        correct = {}
        logits_by_head = {}
        positive_activation = False
        mean_loss = 0.0
        for head in trained_heads:
            inputs = head["features"]
            hidden_one = torch.relu(inputs @ head["parameters"][0].T + head["parameters"][1])
            hidden_two = torch.relu(hidden_one @ head["parameters"][2].T + head["parameters"][3])
            logits = hidden_two @ head["parameters"][4].T + head["parameters"][5]
            positive_activation = positive_activation or bool((hidden_one > 0).any().item())
            # Allowed-set loss: -log(sum_allowed exp / sum_all exp), in the stable
            # log-sum-exp form.
            if not bool(torch.isfinite(logits).all().item()):
                fail_training(
                    "numeric",
                    f"L2 backend bridge head {head['name']} produced non-finite logits",
                    "update",
                    completedUpdates=completed_updates,
                    lastPersistedStep=last_persisted_step,
                )
            shifted = logits - logits.max(dim=1, keepdim=True).values
            exponentials = torch.exp(shifted)
            total = exponentials.sum(dim=1)
            allowed_total = (exponentials * head["allowed"]).sum(dim=1)
            if not bool((allowed_total > 0).all().item()):
                fail_training("numeric", f"L2 backend bridge head {head['name']} has an empty allowed set", "update")
            row_loss = torch.log(total) - torch.log(allowed_total)
            weights = head["weights"]
            head_loss = (weights * row_loss).sum() / head["rowCount"]
            if not bool(torch.isfinite(head_loss).item()):
                fail_training(
                    "numeric",
                    f"L2 backend bridge head {head['name']} produced a non-finite loss",
                    "update",
                    completedUpdates=completed_updates,
                    lastPersistedStep=last_persisted_step,
                )
            losses[head["name"]] = float(head_loss.item())
            mean_loss += float(head_loss.item()) * active_weight
            best = logits.argmax(dim=1)
            hits = head["allowed"].gather(1, best.unsqueeze(1)).squeeze(1)
            correct[head["name"]] = int((weights * hits).sum().item())
            # Analytic gradient of the weighted allowed-set loss. The cotangent is
            # detached so the layer chain rule is applied exactly once:
            #   d loss / d logit = p - p |allowed
            logit_gradient = exponentials / total.unsqueeze(1) - head["allowed"] * (
                exponentials / allowed_total.unsqueeze(1)
            )
            scale = active_weight / head["rowCount"]
            cotangent = (weights * scale).unsqueeze(1) * logit_gradient.detach()
            for parameter in head["parameters"]:
                parameter.grad = None
            (logits * cotangent).sum().backward()
            flat_gradient = []
            for parameter in head["parameters"]:
                if parameter.grad is None:
                    fail_training(
                        "numeric",
                        f"L2 backend bridge head {head['name']} has a parameter without gradient",
                        "update",
                    )
                flat_gradient.extend(parameter.grad.reshape(-1).tolist())
            gradient_by_head[head["name"]] = flat_gradient
            if collect_logits:
                logits_by_head[head["name"]] = logits.detach().cpu().tolist()
        if not bool(torch.isfinite(torch.tensor(mean_loss)).item()):
            fail_training("numeric", "L2 backend bridge produced a non-finite mean loss", "update")
        return losses, mean_loss, correct, gradient_by_head, positive_activation, logits_by_head

    def scores(correct):
        return {
            head["name"]: {"correct": int(correct[head["name"]]), "scored": int(head["rowCount"])}
            for head in trained_heads
        }

    def checkpoint_payload():
        return {
            "schema": CHECKPOINT_SCHEMA,
            "runId": run_id,
            "parameters": parameter_values(),
            "structure": {name: structure.get(name) for name in HEAD_ORDER},
            "trainedHeads": trained_names,
            "completedUpdates": completed_updates,
            "totalBudget": epochs,
            "learningRate": learning_rate,
            "optimizer": {"kind": "full_batch_sgd", "momentum": 0, "state": None},
            "randomness": {"usedInUpdateLoop": False, "seed": request.get("seed")},
            "dataRef": data_ref,
            "recipeRef": recipe_ref,
            "epochZero": epoch_zero,
            "trajectory": trajectory,
            "device": str(device),
            "savedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }

    def persist(state="saving", best_effort=False):
        """Save the committed boundary.

        Returns the checkpoint path on success. On a best-effort save it returns
        `None` and records the failure in `LAST_SAVE_ERROR`; a plain save still
        reports the failure itself. Success and failure never share a return
        value, so a caller reporting another failure can tell a saved boundary
        from a lost one without guessing.
        """
        nonlocal last_persisted_step
        if checkpoint_path is None:
            return None
        emit(state, "save_checkpoint", "start", checkpointStep=completed_updates)
        write_started = time.monotonic()
        try:
            atomic_write_json(checkpoint_path, checkpoint_payload(), previous_checkpoint_path)
        except Exception as error:  # noqa: BLE001 - a save failure must be explicit
            write_ms = int((time.monotonic() - write_started) * 1000)
            timings["checkpointWriteMs"] += write_ms
            timings["checkpointWriteCount"] += 1
            LAST_SAVE_ERROR[0] = f"L2 checkpoint save failed at update {completed_updates}: {error}"
            emit(
                state,
                "save_checkpoint",
                "end",
                checkpointStep=completed_updates,
                phaseMs=write_ms,
                checkpointPath=checkpoint_path,
                saveError=str(error),
            )
            if best_effort:
                # A save attempted while reporting another failure must not mask
                # that failure: the caller reports the original failure and adds
                # this save failure separately.
                return None
            fail(
                "save",
                f"L2 checkpoint save failed at update {completed_updates}: {error}",
                "save_checkpoint",
                completedUpdates=completed_updates,
                lastPersistedStep=last_persisted_step,
            )
        write_ms = int((time.monotonic() - write_started) * 1000)
        timings["checkpointWriteMs"] += write_ms
        timings["checkpointWriteCount"] += 1
        last_persisted_step = completed_updates
        LAST_SAVE_ERROR[0] = None
        previous_exists = previous_checkpoint_path is not None and os.path.exists(previous_checkpoint_path)
        emit(
            state,
            "save_checkpoint",
            "end",
            checkpointStep=completed_updates,
            phaseMs=write_ms,
            checkpointPath=checkpoint_path,
            previousPath=previous_checkpoint_path if previous_exists else None,
        )
        write_event(
            {
                "type": "checkpoint",
                "runId": run_id,
                "state": state,
                "phase": "save_checkpoint",
                "trainedHeads": trained_names,
                "completedUpdates": completed_updates,
                "totalUpdates": epochs,
                "step": completed_updates,
                "path": checkpoint_path,
                "previousPath": previous_checkpoint_path if previous_exists else None,
                "writeMs": write_ms,
                "elapsedMs": int((time.monotonic() - started) * 1000),
                "device": str(device),
                "lastPersistedStep": completed_updates,
            }
        )
        return checkpoint_path

    def fail_training(kind, message, phase, **extra):
        """Report a catchable training failure without losing the last boundary.

        This runs in the scope that owns the committed parameters and persist(),
        so the last complete valid boundary is saved before the terminal error is
        written. The original failure stays the reported failure; a save failure
        is reported separately.
        """
        persist("saving", best_effort=True)
        payload = dict(extra)
        payload.setdefault("completedUpdates", completed_updates)
        payload.setdefault("lastPersistedStep", last_persisted_step)
        if LAST_SAVE_ERROR[0] is not None:
            payload["boundarySaveError"] = LAST_SAVE_ERROR[0]
        fail(kind, message, phase, **payload)

    # ---- reload (resume) ---------------------------------------------------
    if resume:
        emit("init", "reload", "start")
        reload_started = time.monotonic()
        if checkpoint_path is None:
            fail("resume", "L2 resume needs an explicit checkpointPath", "reload")
        if not os.path.exists(checkpoint_path):
            fail("resume", f"L2 resume found no checkpoint at {checkpoint_path}", "reload")
        try:
            stored = read_checkpoint(checkpoint_path)
        except Exception as error:  # noqa: BLE001 - a damaged checkpoint is explicit
            fail("resume", f"L2 checkpoint is unreadable: {error}", "reload")
        if not isinstance(stored, dict):
            fail("resume", "L2 checkpoint is not a JSON object", "reload")
        if stored.get("schema") != CHECKPOINT_SCHEMA:
            fail("resume", "L2 checkpoint schema is not compatible with this build", "reload")
        if list(stored.get("trainedHeads") or []) != trained_names:
            fail(
                "resume",
                "L2 checkpoint trained heads differ from this fit; continuing would change the experiment",
                "reload",
            )
        stored_structure = stored.get("structure") or {}
        for name in HEAD_ORDER:
            if stored_structure.get(name) != structure.get(name):
                fail(
                    "resume",
                    f"L2 checkpoint structure for head {name} differs from this fit; refusing to resume",
                    "reload",
                )
        if stored.get("learningRate") != learning_rate:
            fail("resume", "L2 checkpoint learning rate differs from this fit; refusing to resume", "reload")
        if (stored.get("optimizer") or {}).get("kind") != "full_batch_sgd":
            fail("resume", "L2 checkpoint optimizer differs from this fit; refusing to resume", "reload")
        if stored.get("dataRef") != data_ref:
            fail(
                "resume",
                "L2 checkpoint training material differs from this fit; refusing to resume",
                "reload",
            )
        if stored.get("recipeRef") != recipe_ref:
            fail("resume", "L2 checkpoint recipe differs from this fit; refusing to resume", "reload")
        stored_budget = int(stored.get("totalBudget") or 0)
        if stored_budget != epochs:
            fail(
                "resume",
                f"L2 checkpoint budget {stored_budget} differs from requested {epochs}; a changed budget is a new experiment",
                "reload",
            )
        completed_updates = int(stored.get("completedUpdates") or 0)
        if completed_updates < 0 or completed_updates > epochs:
            fail("resume", "L2 checkpoint step count is outside the requested budget", "reload")
        stored_trajectory = list(stored.get("trajectory") or [])
        if len(stored_trajectory) != completed_updates:
            fail(
                "resume",
                f"L2 checkpoint trajectory has {len(stored_trajectory)} entries but {completed_updates} steps completed",
                "reload",
            )
        stored_parameters = stored.get("parameters") or {}
        # A frozen head must be bit-identical to the requested starting profile:
        # a resumed run may never silently carry a tampered or drifted frozen head.
        for head in heads:
            if head["kind"] != "frozen":
                continue
            stored_flat = stored_parameters.get(head["name"])
            if stored_flat is None:
                fail(
                    "resume",
                    f"L2 checkpoint has no parameters for frozen head {head['name']}",
                    "reload",
                )
            requested_flat = []
            for spec in specs:
                if str(spec["name"]) == head["name"]:
                    # Compare in the stored float32 space; the caller's numbers are
                    # doubles, so a float32 round trip is the honest comparison.
                    requested_flat = [
                        float(value)
                        for value in torch.tensor(spec["parameters"], dtype=torch.float32).tolist()
                    ]
                    break
            if len(stored_flat) != len(requested_flat):
                fail(
                    "resume",
                    f"L2 checkpoint frozen head {head['name']} has {len(stored_flat)} parameters, expected {len(requested_flat)}",
                    "reload",
                )
            mismatch = -1
            for index, (stored_value, requested_value) in enumerate(zip(stored_flat, requested_flat)):
                if stored_value != requested_value:
                    mismatch = index
                    break
            if mismatch >= 0:
                fail(
                    "resume",
                    f"L2 checkpoint frozen head {head['name']} was modified at parameter {mismatch}; refusing to resume",
                    "reload",
                )
        try:
            load_parameters(stored_parameters)
        except KeyError as error:
            fail("resume", f"L2 checkpoint is missing head parameters: {error}", "reload")
        trajectory = stored_trajectory
        epoch_zero = stored.get("epochZero")
        last_persisted_step = completed_updates
        timings["reloadMs"] = int((time.monotonic() - reload_started) * 1000)
        emit(
            "init",
            "reload",
            "end",
            phaseMs=timings["reloadMs"],
            restoredFrom=checkpoint_path,
            restoredStep=completed_updates,
            lastPersistedStep=completed_updates,
        )

    # ---- evaluate-only path ------------------------------------------------
    if op == "evaluate" or epochs == 0:
        emit("init", "first_compute", "start")
        first_started = time.monotonic()
        losses, mean_loss, correct, gradient_by_head, positive_activation, logits_by_head = evaluate(
            collect_logits=True
        )
        timings["firstComputeMs"] = int((time.monotonic() - first_started) * 1000)
        timings["evaluationMs"] += timings["firstComputeMs"]
        emit("init", "first_compute", "end", phaseMs=timings["firstComputeMs"])
        if epoch_zero is None:
            epoch_zero = scores(correct)
        timings["totalMs"] = int((time.monotonic() - started) * 1000)
        finish(
            {
                "type": "final",
                "ok": True,
                "runId": run_id,
                "logitsByHead": logits_by_head,
                "lossByHead": losses,
                "meanLoss": mean_loss,
                "correctByHead": scores(correct),
                "gradient": gradient_by_head,
                "positiveActivation": positive_activation,
                "epochZero": epoch_zero,
                "device": str(device),
                "torch": torch.__version__,
                "selfCheck": self_check,
                "finalWeights": parameter_values(),
                "completedUpdates": completed_updates,
                "totalUpdates": epochs,
                "trajectory": trajectory,
                "lastPersistedStep": last_persisted_step,
                "timings": timings,
            }
        )

    if learning_rate <= 0:
        fail("protocol", "L2 backend bridge needs a positive learning rate for a fit", "initialize")

    # `updatesThisRun` bounds how many updates THIS process performs. The total
    # budget stays `epochs`, so a bounded run hands the remainder to a later
    # process without changing the experiment.
    updates_this_run = request.get("updatesThisRun")
    stop_at = epochs
    if updates_this_run is not None:
        requested_stop = completed_updates + int(updates_this_run)
        if requested_stop < stop_at:
            stop_at = requested_stop

    # From here on the run owns committed parameters, so a catchable failure can
    # save the last complete boundary. Registering here keeps admission rejections
    # above (resume checks, learning-rate check) from writing a checkpoint.
    FAILURE_SINK[0] = fail_training

    # ---- first_compute -----------------------------------------------------
    emit("running", "first_compute", "start")
    first_started = time.monotonic()
    losses, mean_loss, correct, gradient_by_head, positive_activation, _ = evaluate()
    timings["firstComputeMs"] = int((time.monotonic() - first_started) * 1000)
    timings["evaluationMs"] += timings["firstComputeMs"]
    emit("running", "first_compute", "end", phaseMs=timings["firstComputeMs"])
    if completed_updates == 0 and epoch_zero is None:
        epoch_zero = scores(correct)
        if not positive_activation:
            fail_training("numeric", "L2 initialization produced all-zero ReLU activations", "first_compute")
        if not any(any(value != 0.0 for value in values) for values in gradient_by_head.values()):
            fail_training("numeric", "L2 fit has no nonzero gradient at the starting parameters", "first_compute")
    # The initial checkpoint is written after the epoch-zero baseline is known and
    # before the first update, so a resumed run reuses the measured baseline. Its
    # cost is its own phase (checkpointWriteMs), never part of the first step's
    # training time: the first update clock starts after this write.
    if completed_updates == 0:
        persist("saving")

    # ---- update loop -------------------------------------------------------
    warm_started = time.monotonic()
    pending_losses = losses
    pending_gradient = gradient_by_head
    pending_correct = correct
    pending_mean_loss = mean_loss
    # A complete training step is the forward pass, loss and gradient that feed
    # this update, then the parameter update and the required device sync. The
    # first gradient came from the first_compute evaluation, so its cost belongs
    # to the first step; that cost is timings["firstComputeMs"], measured on its
    # own. The initial checkpoint write is excluded: it happened between the two,
    # and it is reported in checkpointWriteMs. The first update clock therefore
    # starts here, immediately before the update loop.
    first_forward_ms = timings["firstComputeMs"]
    pending_started = None
    cancelled = False
    while completed_updates < stop_at:
        if CANCEL_REQUESTED["value"]:
            cancelled = True
            break
        step_started = time.monotonic() if pending_started is None else pending_started
        losses = pending_losses
        gradient_by_head = pending_gradient
        correct = pending_correct
        mean_loss = pending_mean_loss

        # Step atomicity: compute every trained head's candidate first, validate
        # it finite, and only then commit all of them together.
        candidates = {}
        for head in trained_heads:
            flat_gradient = gradient_by_head[head["name"]]
            cursor = 0
            head_candidates = []
            for parameter in head["parameters"]:
                count = int(parameter.numel())
                step = torch.tensor(
                    flat_gradient[cursor:cursor + count], dtype=torch.float32, device=device
                ).reshape(parameter.shape)
                cursor += count
                candidate = parameter - learning_rate * step
                if not bool(torch.isfinite(candidate).all().item()):
                    fail_training(
                        "numeric",
                        f"L2 backend bridge head {head['name']} produced a non-finite parameter update",
                        "update",
                    )
                head_candidates.append(candidate)
            candidates[head["name"]] = head_candidates
        with torch.no_grad():
            for head in trained_heads:
                for parameter, candidate in zip(head["parameters"], candidates[head["name"]]):
                    parameter.copy_(candidate)
        completed_updates += 1
        trajectory.append({"epoch": completed_updates, "loss": dict(losses), "meanLoss": mean_loss})

        # Device synchronization is part of the measured step cost, not hidden
        # from it.
        if device_name == "mps":
            torch.mps.synchronize()
        # The value covers the complete step defined above: forward/loss/gradient,
        # the parameter update and the device sync. Sub-millisecond resolution
        # keeps the distribution usable, because a 240-step hot loop on 77 unique
        # groups runs well below 1 ms per step.
        step_ms = round((time.monotonic() - step_started) * 1000, 4)
        if pending_started is None:
            # First step: add the forward/loss/gradient time measured by
            # first_compute. The initial checkpoint write is not included.
            step_ms = round(step_ms + first_forward_ms, 4)
        step_durations.append(step_ms)
        write_event(
            {
                "type": "step",
                "runId": run_id,
                "state": "running",
                "phase": "update",
                "trainedHeads": trained_names,
                "completedUpdates": completed_updates,
                "totalUpdates": epochs,
                "lossWindow": "pre_update",
                "recentMeanLoss": mean_loss,
                "recentLossByHead": dict(losses),
                "correctByHead": scores(correct),
                "stepMs": step_ms,
                "elapsedMs": int((time.monotonic() - started) * 1000),
                "device": str(device),
                "lastPersistedStep": last_persisted_step,
                "etaMs": eta_ms(),
            }
        )

        # Save the committed boundary first, so a checkpoint write is never
        # charged to the next step's training cost.
        if checkpoint_every > 0 and completed_updates % checkpoint_every == 0:
            persist("saving")

        # Measure the next step's loss and gradient on the committed parameters.
        # This forward pass and backward pass are part of the next step's cost.
        pending_started = time.monotonic()
        pending_losses, pending_mean_loss, pending_correct, pending_gradient, _, _ = evaluate()

    timings["warmTrainingMs"] = int((time.monotonic() - warm_started) * 1000)

    if cancelled:
        # Controlled cancel: the committed parameters are the last complete
        # update, so persisting them is safe and exact.
        persist("paused_or_cancelled")
        emit("paused_or_cancelled", "cancelled", "end", cancelSignal=CANCEL_REQUESTED["signal"])
        timings["totalMs"] = int((time.monotonic() - started) * 1000)
        finish(
            {
                "type": "final",
                "ok": True,
                "cancelled": True,
                "stopReason": "controlled_cancel",
                "cancelSignal": CANCEL_REQUESTED["signal"],
                "runId": run_id,
                "trajectory": trajectory,
                "epochZero": epoch_zero,
                "finalWeights": parameter_values(),
                "epochsCompleted": completed_updates,
                "completedUpdates": completed_updates,
                "totalUpdates": epochs,
                "remainingUpdates": epochs - completed_updates,
                "lastPersistedStep": last_persisted_step,
                "checkpointPath": checkpoint_path,
                "previousCheckpointPath": previous_checkpoint_path,
                "device": str(device),
                "timings": timings,
                "stepMsStats": step_stats(step_durations),
            }
        )

    # ---- evaluate + complete ----------------------------------------------
    emit("running", "evaluate", "start")
    evaluate_started = time.monotonic()
    final_losses, final_mean_loss, final_correct, _, _, _ = evaluate()
    evaluation_ms = int((time.monotonic() - evaluate_started) * 1000)
    timings["evaluationMs"] += evaluation_ms
    emit("running", "evaluate", "end", phaseMs=evaluation_ms)

    persist("saving")
    emit("completed", "complete", "end")
    timings["totalMs"] = int((time.monotonic() - started) * 1000)
    finish(
        {
            "type": "final",
            "ok": True,
            "runId": run_id,
            "trajectory": trajectory,
            "epochZero": epoch_zero,
            "final": scores(final_correct),
            "finalLossByHead": final_losses,
            "finalMeanLoss": final_mean_loss,
            "finalWeights": parameter_values(),
            "epochsCompleted": completed_updates,
            "completedUpdates": completed_updates,
            "totalUpdates": epochs,
            "stoppedEarly": completed_updates < epochs,
            "remainingUpdates": epochs - completed_updates,
            "lastPersistedStep": last_persisted_step,
            "checkpointPath": checkpoint_path,
            "previousCheckpointPath": previous_checkpoint_path,
            "device": str(device),
            "torch": torch.__version__,
            "selfCheck": self_check,
            "elapsedMs": int((time.monotonic() - started) * 1000),
            "timings": timings,
            "stepMsStats": step_stats(step_durations),
        }
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - report the real error to the caller
        # If training already started, save the last complete boundary through the
        # same path as every other catchable failure, then report the original
        # error. Before training starts there is no committed boundary to save, so
        # the admission path stays a plain internal error.
        sink = FAILURE_SINK[0]
        if sink is not None:
            try:
                # fail_training writes the terminal error and exits; the original
                # exception stays the reported message.
                sink("internal", f"L2 backend bridge failed: {error}", "update")
            except SystemExit:
                raise
            except Exception as save_error:  # noqa: BLE001 - never mask the original error
                write_event(
                    {
                        "type": "error",
                        "error": {
                            "kind": "internal",
                            "message": f"L2 backend bridge failed: {error}",
                            "phase": "update",
                            "boundarySaveError": f"L2 checkpoint save failed: {save_error}",
                        },
                    }
                )
                raise SystemExit(0)
        write_event({"type": "error", "error": {"kind": "internal", "message": str(error), "phase": "unknown"}})
        raise SystemExit(0)
