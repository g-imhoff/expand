# CLI Error Contract Design

## Summary

Replace the CLI's flat error-code list and repeated error metadata with domain-owned, descriptor-driven error contracts. Each definition owns its machine-readable code, process exit status, and retryability. The aggregate catalog derives the runtime `ErrorCode` schema and TypeScript union from those definitions.

The refactor preserves the `expand/v1` error codes, JSON envelope shape, exit statuses, retryability, stderr behavior, messages, hints, and input payloads.

## Goals

- Make ownership of each CLI error explicit by domain.
- Keep error code, exit status, and retryability in one definition.
- Derive the aggregate runtime schema and TypeScript type from the domain contracts.
- Keep human-facing content near the adapter that has the required context.
- Preserve existing CLI behavior and compatibility.
- Make adding a future error local to the domain that owns it.

## Non-goals

- Change any existing error code, exit status, or retryability value.
- Change the `expand/v1` error envelope shape.
- Make messages, hints, or input payloads part of the machine contract.
- Move upstream RPC error definitions out of `packages/contracts`.
- Introduce one source file per individual error.
- Add compatibility aliases for retired internal import paths.

## Structure

```text
apps/cli/cli/
├── contract/
│   ├── error/
│   │   ├── definition.ts
│   │   ├── catalog.ts
│   │   └── envelope.ts
│   ├── usage/
│   │   └── errors.ts
│   ├── project/
│   │   ├── envelope.ts
│   │   └── errors.ts
│   ├── server/
│   │   ├── envelope.ts
│   │   └── errors.ts
│   └── system/
│       └── errors.ts
└── errors/
    ├── usage/
    │   └── parser-errors.ts
    ├── project/
    │   ├── errors.ts
    │   └── map-error.ts
    ├── server/
    │   ├── errors.ts
    │   └── map-error.ts
    ├── system/
    │   └── unexpected.ts
    ├── render-errors.ts
    └── index.ts
```

The `contract` tree owns stable machine behavior. The `errors` tree adapts parser, RPC, transport, and unexpected failures into that contract.

## Contract Model

`contract/error/definition.ts` provides the typed definition constructor and definition type. A definition contains exactly:

- `code`: the machine-readable error identifier;
- `exitCode`: the CLI process status;
- `retryable`: whether an automated caller should retry the operation.

Messages, hints, and input payloads are deliberately excluded. They remain presentation details supplied by runtime adapters.

Each domain exports a named record of definitions:

- usage: `INVALID_ARGUMENT`, `INVALID_OPTION`, `UNKNOWN_COMMAND`;
- project: `PROJECT_EXISTS`, `PROJECT_NOT_FOUND`, `NAME_CONFLICT`, `DIRECTORY_INVALID`, `DIRECTORY_CONFLICT`;
- server: `BACKEND_UNREACHABLE`;
- system: `UNEXPECTED`.

`contract/error/catalog.ts` combines the domain records into one catalog. The catalog:

- rejects duplicate machine codes;
- exposes the complete definition collection;
- derives the `ErrorCode` runtime schema;
- derives the `ErrorCode` TypeScript union;
- supports lookup by code where decoding requires it.

The catalog is the only aggregate location. It composes domain definitions without restating their codes or metadata.

`contract/error/envelope.ts` owns `ErrorEnvelope`, JSON encoding, and envelope construction. Its constructor accepts an error definition plus adapter-provided presentation fields. It always obtains `code` and `retryable` from the definition.

## Runtime Adapters

Runtime adapters own contextual presentation and upstream error mapping.

- Usage adapters translate Effect CLI parser failures into usage definitions.
- Project adapters translate public project RPC errors into CLI project definitions.
- Server adapters translate backend discovery and RPC transport failures into the server definition.
- The system adapter translates every otherwise-unrecognized failure into `UNEXPECTED`.

Error classes use the selected definition for both envelope construction and `Runtime.errorExitCode`. They do not repeat a code, exit status, or retryability literal.

The aggregate mapper preserves its current precedence: project mapping, then server mapping, then the unexpected fallback. Parser failures remain a separate path because they originate in the command parser rather than the RPC contract.

## Data Flow

```text
domain definition
    ├── code
    ├── exitCode
    └── retryable
             │
             ▼
runtime adapter
    ├── selects the definition
    ├── builds the message
    ├── supplies optional input
    └── supplies optional hint
             │
             ├──► ErrorEnvelope on stderr
             └──► process exit status
```

All structured error output passes through the contract envelope builder. No producer constructs an error envelope by repeating contract metadata.

## Preserved Behavior

| Domain | Code | Exit status | Retryable |
|---|---|---:|:---:|
| System | `UNEXPECTED` | 1 | No |
| Usage | `INVALID_ARGUMENT` | 2 | No |
| Usage | `INVALID_OPTION` | 2 | No |
| Usage | `UNKNOWN_COMMAND` | 2 | No |
| Project | `PROJECT_EXISTS` | 5 | No |
| Project | `PROJECT_NOT_FOUND` | 7 | No |
| Project | `NAME_CONFLICT` | 8 | No |
| Project | `DIRECTORY_INVALID` | 9 | No |
| Project | `DIRECTORY_CONFLICT` | 10 | No |
| Server | `BACKEND_UNREACHABLE` | 6 | Yes |

Unknown decoded codes continue to fail schema validation. Unknown internal failures continue to use the system fallback. The order of values in generated JSON Schema is not semantic and may change to domain order, but its accepted set remains identical.

## Testing

### Catalog tests

- Assert that every domain definition appears in the aggregate catalog.
- Assert that codes are unique across domains.
- Assert that the derived schema accepts every registered code.
- Assert that the derived schema rejects an unknown code.
- Freeze the complete code, exit-status, and retryability matrix.

### Domain tests

- Verify each parser tag selects the intended usage definition.
- Add direct coverage for `UNKNOWN_COMMAND`.
- Verify every project RPC error tag selects the intended project definition.
- Verify backend and RPC transport failures select `BACKEND_UNREACHABLE`.
- Verify unrecognized failures select `UNEXPECTED`.
- Verify messages, hints, and input payloads remain unchanged.

### Contract and process tests

- Preserve the existing `expand/v1` envelope contract tests.
- Preserve exact JSON output and stderr placement.
- Preserve compiled CLI exit-status assertions.
- Update the envelope schema snapshot only for intentional ordering or structural representation changes that do not alter the accepted code set.

### Architecture tests

- Update the application folder-convention test with the new responsibility paths and retired flat paths.
- Verify no retired internal import path remains.

## Migration

The change is an internal refactor completed in one migration:

1. Introduce the definition primitive and domain definition records.
2. Build the aggregate catalog and derive the error-code schema.
3. Move the error envelope into the contract error folder.
4. Move runtime adapters into their domain folders.
5. Replace repeated code, exit-status, and retryability literals with definition references.
6. Update imports, tests, and architecture assertions.
7. Remove the retired flat error modules.

No compatibility re-exports are retained because the affected paths are internal to the CLI application.

## Acceptance Criteria

- Every emitted CLI error uses a registered definition.
- Code, exit status, and retryability are declared once per error.
- Adding a domain error requires editing its domain contract and adapter, not a central flat list.
- The aggregate `ErrorCode` schema and type are derived from the catalog.
- All existing public CLI error behavior remains unchanged.
- Direct `UNKNOWN_COMMAND` coverage exists.
- Unit, contract, architecture, type-check, and compiled CLI verification pass.
