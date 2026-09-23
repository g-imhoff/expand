# PromptInput design brief

Status: implemented as a desktop renderer design candidate.
Code pin: `ec64cb5c084e1040d004e38a2e514ac2b3ebf6e9`.

## Purpose and scope

`PromptInput` is a reusable composer for a future AI conversation. It accepts a
text draft, a model choice, local image attachments, and optional folder and skill
suggestions. The parent supplies all lists and controlled values. The component
calls the parent when a value changes or the user sends a prompt.

The component has no backend send, upload, persistence, streaming output, or
prompt history. `ProjectsView` mounts it in a "New conversation" preview with
local fixture values and shows the last submitted text. That page does not send
the payload to a conversation service.

## Public contract

The types and option catalogs are exported from
`apps/desktop/src/renderer/features/chat/components/PromptInput.tsx`.

```ts
interface PromptModelOption {
  readonly id: string
  readonly label: string
  readonly provider: string
  readonly description?: string
  readonly disabled?: boolean
}

interface PromptImageAttachment {
  readonly id: string
  readonly name: string
  readonly url: string
}

interface PromptMentionItem {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly kind?: "file" | "folder"
}

interface PromptMention {
  readonly kind: "folder" | "skill"
  readonly key: string
  readonly start: number
  readonly end: number
}

interface PromptSubmitPayload {
  readonly text: string
  readonly modelId: string
  readonly images: ReadonlyArray<PromptImageAttachment>
  readonly mentions: ReadonlyArray<PromptMention>
}

type SandboxMode = "off" | "workspace" | "full"
type PermissionMode = "ask" | "auto-approve" | "read-only"
type ThinkingLevel = "off" | "low" | "high"
```

Required props are `models`, `selectedModelId`, `onModelChange`,
`favoriteModelIds`, `onFavoritesChange`, `images`, `onImagesChange`, `onSend`,
`sandbox`, `onSandboxChange`, `permission`, `onPermissionChange`, `thinking`,
and `onThinkingChange`. Optional props are `folders`, `skills`, `isLoading`,
and `placeholder`. The exported `sandboxModeOptions`, `permissionOptions`,
and `thinkingOptions` arrays supply the menu labels and descriptions.

The model picker groups models by the required `provider` field and searches
their labels, providers, and descriptions. Favorites sort first within a
provider; providers with a favorite sort first. Toggling a favorite calls
`onFavoritesChange` without selecting that model. The selected model stays in
the parent.

The image picker accepts `image/*` files and calls `onImagesChange` with object
URLs, names, and unique component generated IDs. The parent owns the image
array and decides when to remove images or revoke their URLs. Each attachment
has a thumbnail, a remove control, and a dialog preview.

The composer accepts Enter to send and Shift+Enter for a newline. It disables
send for a blank draft or while `isLoading` is true. `onSend` receives trimmed
text, the selected model ID, the current image array, and mentions with offsets
in that trimmed text. Sending clears the draft. It does not clear parent owned
images.

`@` opens suggestions from `folders`, which can include entries marked as files.
`$` opens suggestions from `skills`. The list filters by label without case
sensitivity. Arrow keys move through results; Enter or Tab inserts the selected
label and a space; Escape dismisses the list. The textarea renders folder and
skill tokens with distinct colors through a synchronized backdrop. The send
payload identifies each token as `folder` or `skill`. A suggestion selected
from the list keeps its item ID as `key`, even when labels repeat or contain
spaces. A token typed without selecting a suggestion uses the text after its
marker as `key`. Editing a selected token drops its saved ID. Offsets follow
changes to the draft and refer to the trimmed text in the send payload.

## Design choices

- The model picker uses the existing command wrappers and a popover. It shows
  provider groups, search, descriptions, and a favorite button on each row.
- The `+` menu uses radio groups for sandbox, permissions, and thinking. These
  are controlled visual settings; this component does not enforce them.
- Image thumbnails use a dialog for the full image. The dialog title truncates
  long filenames within the available width.
- The composer uses the project's theme tokens. The send button uses the
  primary color; the shell and popover have larger corners than menu rows.
- The textarea stays two rows high and scrolls internally. Its text is
  transparent so a synchronized backdrop can show mention colors while the
  caret remains visible.

## Responsive and accessibility behavior

The toolbar wraps when width is constrained, the model trigger truncates long
labels, and image cards wrap. The parent sets the composer width. The textarea
has a persistent accessible label and reports its open mention list as a
combobox with an active option. Image controls include filenames in their
accessible names, and a live status announces sending. The picker and menus
use their shared keyboard and focus behavior.

## Implementation and examples

- `apps/desktop/src/renderer/features/chat/components/PromptInput.tsx` holds
  the composer and its public contract.
- `ModelPicker.tsx`, `provider-logos.tsx`, `prompt-mentions.ts`, and
  `mention-segments.tsx` implement model browsing and mention display.
- `apps/desktop/src/renderer/components/ui/command.tsx`, `dropdown-menu.tsx`,
  and `popover.tsx` provide the shared picker and menu controls.
- `apps/desktop/src/renderer/index.css` holds the theme tokens.
- `apps/desktop/src/renderer/features/projects/pages/ProjectsView.tsx` mounts
  the local homepage preview.
- `apps/desktop/test/ui/prompt-input.test.tsx` tests the component contract.
- `examples/prompt-input-specimen/` is an isolated Vite specimen that imports
  the real component and renderer stylesheet with synthetic fixture data.

## Verification

These are full SHA-256 content hashes for the files at code pin `ec64cb5c084e1040d004e38a2e514ac2b3ebf6e9`:

```text
b90758c0590d1429036e78ee77a6776ac2637aa552fedfb7a867d7edb07d6b1a  apps/desktop/src/renderer/features/chat/components/PromptInput.tsx
11f718a6f1a86dc78c185761125f64c009894d646619b46ab80845f0482d355c  apps/desktop/src/renderer/features/chat/components/ModelPicker.tsx
8976e8509f5458b29c49d001739d24d341492a80f46ccfe3f9b4b184a3101b48  apps/desktop/src/renderer/features/chat/components/provider-logos.tsx
e842e8ebad7bdbb5ec21b3f3ce300f0811afff70b8f177b923bb504666caf8ad  apps/desktop/src/renderer/features/chat/components/prompt-mentions.ts
cec01a6e119a6059dae31b9149f87b97357cca135150354bcfd94bd6498c2403  apps/desktop/src/renderer/features/chat/components/mention-segments.tsx
8b553ea870482ef71d8436826c2077ea57ff86772773718bb15894e7aad2789c  apps/desktop/src/renderer/features/projects/pages/ProjectsView.tsx
8ac7209b79b191dc57aa6a8b5e8c2ab687f6aff8496247480981cf438ec0b9ab  apps/desktop/test/ui/prompt-input.test.tsx
6c7000220864238f94e3488a1cd00b5de2f2efd41562258371af7193b176dec6  examples/prompt-input-specimen/src/App.tsx
```

The checks below ran against that pin in the documentation worktree:

- `npm test -- apps/desktop/test/ui/prompt-input.test.tsx`: 27 tests passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run knip`: passed.
- `tsc --noEmit -p examples/prompt-input-specimen/tsconfig.json`: passed.
- `vite build examples/prompt-input-specimen --config examples/prompt-input-specimen/vite.config.ts`: passed. The local build has 3 files and 370303 bytes.

`design/prompt-input-hosted-preview.json` records the earlier hosted bundle and
the local build separately. The hosted bundle has not been redeployed or
compared with the current code pin, so its status remains historical.

## Integration work

The conversation host must supply real models, folder and skill suggestions,
state for the menu options and images, and a send handler. It must decide when
to clear images and revoke object URLs. Full page overflow, accessibility, and
contrast checks belong with the conversation host because the present homepage
mount uses fixture data.
