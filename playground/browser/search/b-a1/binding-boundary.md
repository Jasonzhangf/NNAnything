# B-A1 text search explicit binding boundary

This slice accepts only explicit object bindings. It does not learn or infer
which page object is the search input. A request must provide the query, the
text input binding, the submit binding, the result scope, and the collection
binding. The target is an ordinary text `input`; placeholder text is never
accepted as the current value.

## Minimum accepted input

- `goal.query`: the exact non-empty value to write.
- `goal.collectionRef`, `goal.containsText`, `goal.minimumMatches`, and
  `goal.coverage`: the result contract checked after submission.
- `bindings.documentRef`, `bindings.scopeRef`, and `bindings.inputRef`: the
  explicit current text target.
- `bindings.submitRef`, `bindings.resultScopeRef`, and `bindings.collectionRef`:
  the explicit submit and result objects.

The public path is `playground/browser/search/run.mjs`, backed by
`runBrowserSearchGoal` and `playground/browser/search/native-io.mjs`. Input is
performed by native keyboard events and observed by read-only `input.value`.
The neighboring input is read again after the run.

## Expected behavior

1. An editable empty target receives one native text write. The exact query must
   be read back before submit, and the neighbor value must remain unchanged.
2. When placeholder equals the query but value is empty, the target still
   receives a native write. Placeholder equality never means the value is set.
3. If an input event resets the target, the input fact is unsatisfied and no
   submit is dispatched.
4. A readonly target is refused before native dispatch. Neither the readonly
   target nor the neighbor is written.
5. If the executor throws after dispatch, the actual value is read safely. The
   execution error and the observed value remain separate; no submit follows.
6. If post-action read fails, the value fact stays unknown, the observation
   error remains separate, and no submit follows.

## Refusals and INCOMPLETE boundary

Refuse or stop without submit when the explicit binding is missing, stale, or
not an ordinary editable text input; when readonly/disabled or hit state is not
confirmed; when post-action value observation is unavailable; and when the
value differs from the exact query. An execution failure does not erase an
observed value, and an observed value does not erase an execution failure.

This slice does not implement autonomous object binding, object selection
training, textarea or contenteditable input, arbitrary search-page discovery,
or automatic candidate adoption. Those items are INCOMPLETE. No training,
weight, threshold, gold, or adoption change is part of this slice.
