import { mimeTypeFor } from '@/lib/files/fileKinds'
import { MAX_FILES_PER_MESSAGE } from '@/lib/files/uploadPolicy'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'

/**
 * The two ways a file gets into the composer — the phone's answer to the
 * desktop's file dialog, drag-and-drop and clipboard paste.
 *
 * Both pickers hand back a copy in the app's cache directory, which is what
 * makes staging possible: nothing is uploaded here, the bytes simply sit
 * where the send path can reach them until the user sends or removes them.
 *
 * Neither picker asks for a permission. The photo library goes through the
 * system picker (PHPicker on iOS, the Android photo picker), which runs out of
 * process and returns only what the user chose — there is nothing to grant.
 */

export type PickedFile = {
  /** Identity for the staging tray; two picks of one file stage twice. */
  id: string
  /** Local file URI — the send path reads its bytes from here. */
  uri: string
  /** What the desktop will name it. Its extension decides everything. */
  name: string
  mimeType: string
  sizeBytes: number
  /** Media dimensions and length, when the picker measured them. The desktop
   *  stores all three on the attachment, exactly as its own composer does. */
  width?: number
  height?: number
  durationSeconds?: number
}

let sequence = 0

function nextId(): string {
  sequence += 1
  return `pick_${Date.now().toString(36)}_${sequence}`
}

/** Lowercase extension of a URI, ignoring any query or fragment. */
function extensionOfUri(uri: string): string {
  const path = uri.split(/[?#]/)[0]
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

/**
 * The size expo could not tell us. Both pickers usually report one, but the
 * Android photo picker can return an asset with no size at all, and a 0 here
 * would sail past every cap.
 */
function sizeOf(uri: string, reported: number | undefined | null): number {
  if (typeof reported === 'number' && reported > 0) return reported
  try {
    return new File(uri).size ?? 0
  } catch {
    return 0
  }
}

/**
 * A library asset often arrives with no filename — a phone camera roll has
 * asset ids, not names. The extension is what the desktop validates and
 * classifies on, so it comes from the URI (which the picker always suffixes
 * correctly) and the stem is a readable timestamp, the same shape the desktop
 * gives a pasted screenshot.
 */
function assetName(asset: ImagePicker.ImagePickerAsset): string {
  const ext = extensionOfUri(asset.uri) || (asset.type === 'video' ? 'mp4' : 'jpg')
  const suggested = asset.fileName?.trim()
  if (suggested) {
    // A suggested name without the extension the file actually has would be
    // classified as the wrong type on the desktop.
    return extensionOfUri(suggested) === ext ? suggested : `${suggested}.${ext}`
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${asset.type === 'video' ? 'video' : 'photo'}-${stamp}.${ext}`
}

/**
 * Photos and videos from the system library.
 *
 * `Compatible` representation is the load-bearing option: left to itself the
 * iOS picker hands back the asset as it is stored, which for any recent iPhone
 * means HEIC — a type the desktop does not accept, so every photo would be
 * refused at the pick. Compatible makes the system transcode to JPEG (and
 * H.264 for video) before we ever see the file, which is exactly the file a
 * desktop user would have dropped on the composer.
 *
 * `quality: 1` then keeps expo from re-encoding what the system already
 * produced — the raw representation is copied through untouched.
 */
export async function pickMedia(remainingSlots: number): Promise<PickedFile[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: true,
    selectionLimit: Math.max(1, Math.min(remainingSlots, MAX_FILES_PER_MESSAGE)),
    allowsEditing: false,
    quality: 1,
    exif: false,
    base64: false,
    preferredAssetRepresentationMode:
      ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible
  })
  if (result.canceled) return []
  return result.assets.map((asset) => {
    const name = assetName(asset)
    return {
      id: nextId(),
      uri: asset.uri,
      name,
      mimeType: asset.mimeType || mimeTypeFor(name),
      sizeBytes: sizeOf(asset.uri, asset.fileSize),
      ...(asset.width > 0 && asset.height > 0 ? { width: asset.width, height: asset.height } : {}),
      ...(typeof asset.duration === 'number' && asset.duration > 0
        ? { durationSeconds: asset.duration / 1000 }
        : {})
    }
  })
}

/**
 * Anything from the Files app / document providers.
 *
 * Deliberately unfiltered. Restricting the sheet by type would have to be done
 * in UTIs and Android MIME types, and the mapping is lossy in both directions —
 * a .md file has no registered type on iOS and would simply be invisible. So
 * the picker shows everything and the same validation the desktop runs decides,
 * which means an unsupported file is refused with a message rather than being
 * silently unpickable.
 */
export async function pickDocuments(): Promise<PickedFile[]> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    multiple: true,
    copyToCacheDirectory: true
  })
  if (result.canceled) return []
  return result.assets.map((asset) => {
    const name = asset.name?.trim() || `file-${Date.now()}`
    return {
      id: nextId(),
      uri: asset.uri,
      name,
      mimeType: asset.mimeType || mimeTypeFor(name),
      sizeBytes: sizeOf(asset.uri, asset.size)
    }
  })
}
