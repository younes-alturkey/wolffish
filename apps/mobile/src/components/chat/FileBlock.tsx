import { classifyFile, isPlayable, type DeclaredFileKind } from '@/lib/files/fileKinds'
import { useMemo } from 'react'
import { Platform } from 'react-native'
import { ChartFileCard } from '@/components/chat/ChartCard'
import type { Align } from '@/components/chat/FileChrome'
import {
  GenericFileCard,
  HtmlFileCard,
  OfficeFileCard,
  PdfFileCard,
  SheetFileCard,
  TextFileCard
} from '@/components/chat/FileViewers'
import { AudioBlock, ImageBlock, VideoBlock } from '@/components/chat/MediaBlocks'

/**
 * The one place a file becomes a viewer. Both delivered files (send_file's
 * `[wolffish-output:]` markers) and message attachments route through here, so
 * a .csv looks the same whether the model produced it or the user attached it
 * — the desktop invariant (Chat.tsx and AttachmentList share their dispatch
 * table) held on mobile.
 */
export function FileBlock({
  relPath,
  conversationId,
  declared,
  sizeBytes,
  displayName,
  align = 'start'
}: {
  /** Workspace-relative path — resolved through the file cache. */
  relPath: string
  conversationId?: string
  /** attachment.type, or the output marker's kind — breaks extension ties. */
  declared?: DeclaredFileKind
  sizeBytes?: number
  /** attachment.originalName when known; otherwise the path's basename. */
  displayName?: string
  align?: Align
}): React.JSX.Element {
  const classification = useMemo(
    () => classifyFile(displayName ?? relPath, declared),
    [displayName, relPath, declared]
  )

  // Every inline viewer degrades to this card — missing file, oversized body,
  // unreadable binary, or a platform that can't render the format.
  const fallback = (
    <GenericFileCard
      relPath={relPath}
      conversationId={conversationId}
      sizeBytes={sizeBytes}
      displayName={displayName}
      classification={classification}
      align={align}
    />
  )

  const shared = {
    relPath,
    conversationId,
    classification,
    sizeBytes,
    displayName,
    align,
    fallback
  }

  switch (classification.kind) {
    case 'image':
      return (
        <ImageBlock
          relPath={relPath}
          conversationId={conversationId}
          align={align}
          sizeBytes={sizeBytes}
          displayName={displayName}
        />
      )
    case 'video':
      // A container this device has no decoder for never becomes a player.
      if (!isPlayable('video', classification.ext, Platform.OS, Platform.Version)) return fallback
      return (
        <VideoBlock
          relPath={relPath}
          conversationId={conversationId}
          align={align}
          displayName={displayName}
          fallback={fallback}
        />
      )
    case 'audio':
      if (!isPlayable('audio', classification.ext, Platform.OS, Platform.Version)) return fallback
      return (
        <AudioBlock
          relPath={relPath}
          conversationId={conversationId}
          align={align}
          displayName={displayName}
        />
      )
    case 'pdf':
      return <PdfFileCard {...shared} />
    case 'chart':
      return <ChartFileCard {...shared} />
    case 'html':
      return <HtmlFileCard {...shared} />
    case 'sheet':
      return <SheetFileCard {...shared} />
    case 'document':
    case 'workbook':
    case 'slides':
      return <OfficeFileCard {...shared} />
    case 'markdown':
    case 'text':
    case 'code':
      return <TextFileCard {...shared} />
    default:
      return fallback
  }
}
