import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Image,
  ScrollView,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import { Feather } from '@expo/vector-icons';
import { WebSocketService } from '../services/websocket.service';
import { colors, fonts } from '../theme';
import { useResponsive } from '../hooks/useResponsive';

interface Props {
  sessionId: string | undefined;
  wsService: WebSocketService;
  serverHost: string;
  serverPort: number;
  serverToken: string;
}

type UploadState = 'idle' | 'picking' | 'uploading' | 'done' | 'error';

const MAX_GALLERY_SELECTION = 12;

export function ScreenshotPanel({ sessionId, wsService, serverHost, serverPort, serverToken }: Props) {
  const { rf, rs, ri } = useResponsive();
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [uploadedPaths, setUploadedPaths] = useState<string[]>([]);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [pathCopied, setPathCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lastPath = uploadedPaths.length > 0 ? uploadedPaths[uploadedPaths.length - 1] : null;

  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);

  const reset = useCallback(() => {
    setUploadState('idle');
    setUploadedPaths([]);
    setUploadProgress({ current: 0, total: 0 });
    setPreviewUri(null);
    setErrorMsg('');
    setPathCopied(false);
  }, []);

  const uploadSingle = useCallback(async (asset: ImagePicker.ImagePickerAsset): Promise<string | null> => {
    if (!asset.base64) return null;
    const filename = asset.fileName ?? `screenshot_${Date.now()}.jpg`;
    const uploadUrl = `http://${serverHost}:${serverPort}/upload/screenshot`;

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serverToken}`,
      },
      body: JSON.stringify({
        filename,
        data: asset.base64,
        mimeType: asset.mimeType ?? 'image/jpeg',
      }),
    });
    if (!response.ok) throw new Error(`Server error ${response.status}`);
    const json = await response.json() as { path: string };
    return json.path;
  }, [serverHost, serverPort, serverToken]);

  const uploadMultiple = useCallback(async (assets: ImagePicker.ImagePickerAsset[]) => {
    setUploadState('uploading');
    setUploadProgress({ current: 0, total: assets.length });

    const paths: string[] = [];
    const errors: string[] = [];

    for (let i = 0; i < assets.length; i++) {
      try {
        const path = await uploadSingle(assets[i]);
        if (path) {
          paths.push(path);
          if (sessionId) {
            wsService.send({ type: 'terminal:input', sessionId, payload: { data: path } });
          }
        } else {
          errors.push(`Bild ${i + 1}: keine Daten`);
        }
      } catch (err: unknown) {
        errors.push(`Bild ${i + 1}: ${err instanceof Error ? err.message : 'Fehler'}`);
      }
      setUploadProgress({ current: i + 1, total: assets.length });
    }

    setUploadedPaths(paths);
    if (assets.length > 0) setPreviewUri(assets[0].uri);

    if (paths.length === 0) {
      setUploadState('error');
      setErrorMsg(errors.join('\n') || 'Kein Bild konnte hochgeladen werden');
    } else if (errors.length > 0) {
      setUploadState('done');
      setErrorMsg(`${errors.length} fehlgeschlagen`);
    } else {
      setUploadState('done');
    }
  }, [sessionId, wsService, uploadSingle]);

  const pickFromGallery = useCallback(async () => {
    setUploadState('picking');
    setErrorMsg('');
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setUploadState('error');
        setErrorMsg('Galerie-Zugriff verweigert');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        selectionLimit: MAX_GALLERY_SELECTION,
        quality: 1,
        base64: true,
      });
      if (result.canceled || !result.assets?.length) {
        setUploadState('idle');
        return;
      }
      await uploadMultiple(result.assets);
    } catch (err: unknown) {
      setUploadState('error');
      setErrorMsg(err instanceof Error ? err.message : 'Unbekannter Fehler');
    }
  }, [uploadMultiple]);

  const pickFromCamera = useCallback(async () => {
    setUploadState('picking');
    setErrorMsg('');
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        setUploadState('error');
        setErrorMsg('Kamera-Zugriff verweigert');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        quality: 1,
        base64: true,
      });
      if (result.canceled || !result.assets?.length) {
        setUploadState('idle');
        return;
      }
      await uploadMultiple(result.assets);
    } catch (err: unknown) {
      setUploadState('error');
      setErrorMsg(err instanceof Error ? err.message : 'Unbekannter Fehler');
    }
  }, [uploadMultiple]);

  const copyAllPaths = useCallback(async () => {
    if (!uploadedPaths.length) return;
    await Clipboard.setStringAsync(uploadedPaths.join('\n'));
    setPathCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setPathCopied(false), 1600);
  }, [uploadedPaths]);

  return (
    <View style={s.container}>
      {/* Header */}
      <View style={[s.header, { paddingHorizontal: rs(12), paddingVertical: rs(10), gap: rs(7) }]}>
        <Feather name="image" size={ri(14)} color={colors.info} />
        <Text style={[s.title, { fontSize: rf(13) }]}>Screenshots</Text>
      </View>
      <View style={s.divider} />

      {/* Idle — pick buttons */}
      {uploadState === 'idle' && (
        <View style={s.body}>
          <Text style={[s.hint, { fontSize: rf(11) }]}>Bild hochladen → Pfad ins Terminal</Text>

          {/* Gallery button */}
          <TouchableOpacity
            style={[s.primaryBtn, { paddingVertical: rs(12), paddingHorizontal: rs(14), gap: rs(12) }]}
            onPress={pickFromGallery}
            activeOpacity={0.75}
            accessibilityLabel="Pick from gallery"
            accessibilityRole="button"
          >
            <Feather name="image" size={ri(22)} color={colors.info} />
            <View>
              <Text style={[s.primaryBtnLabel, { fontSize: rf(13) }]}>Galerie</Text>
              <Text style={[s.primaryBtnSub, { fontSize: rf(10) }]}>Bis zu {MAX_GALLERY_SELECTION} Bilder</Text>
            </View>
          </TouchableOpacity>

          {/* Camera button */}
          <TouchableOpacity
            style={[s.secondaryBtn, { paddingVertical: rs(12), paddingHorizontal: rs(14), gap: rs(12) }]}
            onPress={pickFromCamera}
            activeOpacity={0.75}
            accessibilityLabel="Take photo"
            accessibilityRole="button"
          >
            <Feather name="camera" size={ri(22)} color={colors.textMuted} />
            <View>
              <Text style={[s.secondaryBtnLabel, { fontSize: rf(13) }]}>Kamera</Text>
              <Text style={[s.secondaryBtnSub, { fontSize: rf(10) }]}>Foto aufnehmen</Text>
            </View>
          </TouchableOpacity>

          {/* Destination hint */}
          <View style={s.destRow}>
            <Text style={s.destLabel}>Ziel</Text>
            <Text style={s.destPath}>~/Desktop/Screenshots/</Text>
          </View>
        </View>
      )}

      {/* Loading */}
      {(uploadState === 'picking' || uploadState === 'uploading') && (
        <View style={s.centered}>
          <ActivityIndicator color={colors.info} size="large" />
          <Text style={s.loadingText}>
            {uploadState === 'picking'
              ? 'Galerie öffnet…'
              : uploadProgress.total > 1
                ? `${uploadProgress.current}/${uploadProgress.total} hochgeladen…`
                : 'Wird hochgeladen…'}
          </Text>
        </View>
      )}

      {/* Done */}
      {uploadState === 'done' && uploadedPaths.length > 0 && (
        <View style={s.body}>
          {/* Thumbnail */}
          {previewUri && (
            <View style={s.thumbWrap}>
              <Image source={{ uri: previewUri }} style={s.thumb} resizeMode="cover" />
              <View style={s.thumbBadge}>
                <Feather name="check" size={12} color={colors.bg} />
              </View>
              {uploadedPaths.length > 1 && (
                <View style={s.thumbCount}>
                  <Text style={s.thumbCountTxt}>{uploadedPaths.length}</Text>
                </View>
              )}
            </View>
          )}

          <Text style={s.successLabel}>
            {uploadedPaths.length === 1
              ? 'Hochgeladen & verlinkt'
              : `${uploadedPaths.length} Bilder hochgeladen`}
          </Text>
          {errorMsg ? <Text style={s.partialError}>{errorMsg}</Text> : null}

          {/* Path box — scrollable for multiple */}
          <ScrollView style={s.pathScroll} nestedScrollEnabled>
            <View style={s.pathBox}>
              {uploadedPaths.map((p, i) => (
                <Text key={i} style={s.pathTxt} numberOfLines={2}>
                  {uploadedPaths.length > 1 ? `${i + 1}. ` : ''}{p}
                </Text>
              ))}
            </View>
          </ScrollView>

          {/* Actions */}
          <View style={s.actionRow}>
            <TouchableOpacity
              style={[s.actionBtn, s.actionBtnCopy, pathCopied && s.actionBtnCopied]}
              onPress={copyAllPaths}
              activeOpacity={0.75}
              accessibilityLabel={pathCopied ? 'Paths copied' : 'Copy file paths'}
              accessibilityRole="button"
            >
              <View style={s.actionBtnInner}>
                <Feather name={pathCopied ? 'check' : 'copy'} size={12} color={pathCopied ? colors.accent : colors.primary} />
                <Text style={[s.actionBtnTxt, pathCopied && s.actionBtnTxtCopied]}>
                  {pathCopied
                    ? 'Kopiert'
                    : uploadedPaths.length > 1
                      ? `${uploadedPaths.length} Pfade kopieren`
                      : 'Pfad kopieren'}
                </Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity style={[s.actionBtn, s.actionBtnAgain]} onPress={reset} activeOpacity={0.75}>
              <Text style={s.actionBtnTxtMuted}>Weiteres</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Error */}
      {uploadState === 'error' && (
        <View style={s.centered}>
          <Feather name="alert-triangle" size={28} color={colors.destructive} />
          <Text style={s.errorText}>{errorMsg}</Text>
          <TouchableOpacity style={s.retryBtn} onPress={reset} activeOpacity={0.75}>
            <Text style={s.retryTxt}>Erneut versuchen</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 7,
  },
  title: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(51,65,85,0.7)',
  },
  body: {
    paddingHorizontal: 12,
    paddingTop: 14,
    gap: 10,
  },
  hint: {
    color: colors.textDim,
    fontSize: 11,
    marginBottom: 2,
  },

  // ── Buttons
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  primaryBtnLabel: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  primaryBtnSub: {
    color: colors.textDim,
    fontSize: 10,
    marginTop: 1,
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  secondaryBtnLabel: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  secondaryBtnSub: {
    color: colors.textDim,
    fontSize: 10,
    marginTop: 1,
  },

  // ── Destination hint
  destRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
    paddingHorizontal: 2,
  },
  destLabel: {
    color: colors.textDim,
    fontSize: 10,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    fontWeight: '600',
  },
  destPath: {
    color: colors.textDim,
    fontSize: 10,
    fontFamily: fonts.mono,
  },

  // ── Centered states
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 16,
  },
  loadingText: {
    color: colors.textDim,
    fontSize: 12,
  },

  // ── Done state
  thumbWrap: {
    alignSelf: 'center',
    width: 120,
    height: 80,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#313244',
    marginBottom: 2,
  },
  thumb: {
    width: 120,
    height: 80,
  },
  thumbBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbCount: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  thumbCountTxt: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
  },
  successLabel: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  pathScroll: {
    maxHeight: 120,
  },
  pathBox: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  partialError: {
    color: colors.warning,
    fontSize: 10,
    textAlign: 'center',
  },
  pathTxt: {
    color: colors.info,
    fontSize: 10,
    fontFamily: fonts.mono,
    lineHeight: 15,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
    borderWidth: 1,
  },
  actionBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  actionBtnCopy: {
    backgroundColor: 'rgba(59,130,246,0.08)',
    borderColor: colors.border,
  },
  actionBtnCopied: {
    backgroundColor: 'rgba(34,197,94,0.12)',
    borderColor: colors.accent,
  },
  actionBtnTxt: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: '700',
  },
  actionBtnTxtCopied: { color: colors.accent },
  actionBtnAgain: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    flex: 0,
    paddingHorizontal: 14,
  },
  actionBtnTxtMuted: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: '600',
  },

  // ── Error state
  errorText: {
    color: colors.destructive,
    fontSize: 12,
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 4,
    paddingVertical: 8,
    paddingHorizontal: 18,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
  },
  retryTxt: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
});
