# Discord media and Markdown delivery

This inventory describes the source adapter and offline transport tests, not a live Discord rendering or playback acceptance test.

## Assistant Markdown

The shared text bridge marks normal assistant answers as Markdown and passes them to `DiscordBotClient.sendDelivery`. Discord receives native message `content`, not HTML. Short headings, emphasis, links, quotes, lists, spoilers and code fences pass through unchanged. Mentions are disabled in the API payload (`allowed_mentions.parse=[]`, `replied_user=false`).

Markdown replies are split at 1,900 UTF-16 code units, below the adapter's 2,000-character Discord message ceiling. The shared chunker keeps fitting code blocks intact and wraps oversized code pieces in independently closed fences. Unicode surrogate pairs survive splits. Only the first text chunk references the incoming message. The chunker also preserves/splits GFM table structure, but this does not establish that Discord renders GFM tables. Long individual lines are hard-split; inline links/emphasis spanning that split are not structurally repaired. Short unfinished fences remain as authored.

`sendText` uses the ordinary text splitter; proactive messages need `format: 'markdown'` to select the structure-aware path. Recovery of recorded assistant answers also selects Markdown. The normal final path is separate from the progress stream.

## Registered files and media

`dsh_im_return_file` registers a readable local file for the owning IM turn. It accepts existing files and uses a private snapshot, then uploads after that turn completes. Successful registration means queued, not delivered. A bare Web/Desktop session without an active IM consumer cannot queue a file.

Discord uses one native multipart attachment message per artifact, including images. There is no separate image conversion or video transcoding. The API preserves filename, bytes and inferred MIME type, disables mentions, carries the reply reference, and uses a stable nonce when a delivery key is present. The shared layer records provider message IDs and artifact delivery outcomes.

Known image mappings include PNG, JPEG, GIF and WebP. Video mappings now include MP4, WebM, MOV and M4V; audio mappings include MP3, M4A, AAC, WAV, OGG, Opus and FLAC. Extension matching is case-insensitive. Unknown extensions retain `application/octet-stream`. MIME inference uses the extension, not a decoder or content inspection; playback still depends on valid bytes, codecs and the Discord client.

There is no project-level attachment size/count quota in registration. Provider limits and permissions still apply. Uploads materialize the whole file in memory and have a 120-second default API upload timeout. Discord rejection maps to permission/too-large/rate-limit/provider-rejected outcomes. Post-dispatch network/server failures become uncertain delivery; they must not be reported as confirmed success or blindly resent. A 429 gets one bounded retry with the same body and nonce.

The artifact tool takes only a path. It does not expose attachment captions, descriptions/alt text, thumbnails, per-file spoiler controls, attachment grouping or arbitrary rich embeds. A filename may retain Discord-specific semantics, but there is no dedicated feature contract for them.

## Offline verification

`test/channels/discord/media-richtext.test.mjs` verifies short Markdown payload preservation and mention suppression, long fenced Unicode answers, explicitly typed video multipart data, and registry-to-Discord transport for documents, images, videos, audio and unknown extensions. All API calls use injected fake fetch functions; synthetic fixtures are never sent externally.

Related suites cover the full Discord adapter, shared session-sync Markdown, the shared chunker through QQ tests, artifact delivery fallback/uncertainty, consumer ownership, prompt guidance and snapshot recovery. Real Discord image rendering, video playback, actual account upload limits and production deployment are outside this offline verification.
