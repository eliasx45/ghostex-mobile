/**
 * The image tiles above the input (`attachment_previews.rs`): one 48pt thumbnail per image
 * reference in the draft, with its remove button (always shown: a phone has no hover), plus a
 * spinner tile per upload still in flight (`pendingAttachments`). Tapping a tile opens the image
 * viewer, as a click does on desktop.
 */

import { useEffect, useRef } from 'react';
import { ActivityIndicator, Image, Pressable, View } from 'react-native';

import type { UserAction } from '../../rust/actions';
import type { ChatImageState } from '../../rust/host';
import { openChatImageViewer, type ChatImage } from '../cards';
import { Glyph } from './icons';
import { themedStyles, useTranscriptTheme } from '../transcript/theme';
import type { ComposerReference } from './references';

export function AttachmentPreviews({
  references,
  pending,
  images,
  draft,
  active,
  dispatch,
  onRemoveImage,
}: {
  references: readonly ComposerReference[];
  pending: number;
  images: { [path: string]: ChatImageState };
  draft: string;
  active: string | null;
  dispatch: (action: UserAction) => void;
  /** Drops a picture by its `[Image #N](path)` source; false when it is not one the field hides. */
  onRemoveImage?: (source: string) => boolean;
}) {
  const styles = useStyles();
  const P = useTranscriptTheme();
  const tiles = references.filter((reference) => reference.kind === 'image');
  const requested = useRef(new Set<string>());
  useEffect(() => {
    for (const tile of tiles) {
      if (images[tile.path] !== undefined || requested.current.has(tile.path)) continue;
      requested.current.add(tile.path);
      dispatch({ type: 'loadImage', path: tile.path });
    }
  }, [tiles, images, dispatch]);
  if (tiles.length === 0 && pending === 0) return null;
  const viewerImages: ChatImage[] = tiles.map((tile) => ({
    transport: 'read',
    path: tile.path,
    label: tile.label,
    copyPath: tile.path,
    fileName: tile.path.replace(/^.*[\\/]/u, ''),
  }));
  return (
    <View style={styles.row}>
      {tiles.map((tile, index) => {
        const image = images[tile.path];
        return (
          <View key={`${tile.start}:${tile.path}`} style={styles.tileWrap}>
            <Pressable
              onPress={() => openChatImageViewer(viewerImages, index)}
              accessibilityRole="imagebutton"
              accessibilityLabel={`View ${tile.label}`}
              style={[styles.tile, active === tile.path ? styles.tileActive : null]}
            >
              {image?.status === 'loaded' ? (
                <Image
                  source={{ uri: `data:${image.mediaType};base64,${image.base64Data}` }}
                  style={styles.image}
                  resizeMode="cover"
                />
              ) : image === undefined ? (
                <ActivityIndicator size="small" color={P.muted} />
              ) : (
                <Glyph name="photo" size={18} color={P.muted} />
              )}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Remove image"
              hitSlop={8}
              onPress={() => {
                if (onRemoveImage?.(draft.slice(tile.start, tile.end)) === true) return;
                dispatch({ type: 'removeAttachment', text: draft, start: tile.start, end: tile.end });
              }}
              style={styles.remove}
            >
              <Glyph name="x" size={10} color={P.foreground} strokeWidth={2.4} />
            </Pressable>
          </View>
        );
      })}
      {Array.from({ length: pending }, (_, index) => (
        <View key={`pending:${index}`} style={styles.tile}>
          <ActivityIndicator size="small" color={P.muted} />
        </View>
      ))}
    </View>
  );
}

const useStyles = themedStyles((P) => ({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, paddingTop: 4, paddingBottom: 8 },
  tileWrap: { width: 48, height: 48 },
  tile: {
    width: 48,
    height: 48,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: P.inputBorder,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: P.background,
  },
  tileActive: { borderColor: P.foreground, borderWidth: 2 },
  image: { width: '100%', height: '100%' },
  remove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: P.inputBorder,
    backgroundColor: P.light ? P.menu : '#262626',
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
