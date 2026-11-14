import { Image } from 'expo-image';
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Hairline, Spacing, Status, Type } from '@/constants/theme';
import { pictureUri } from '@/history/files';
import type { SecurityEntry, SecurityKind } from '@/security/security-log';

const LABEL: Record<SecurityKind, string> = {
  armed: 'Armed',
  disarmed: 'Disarmed',
  tamper: 'Bike moved',
  motion: 'Motion nearby',
  siren: 'Alarm sounded from phone',
};

const DOT: Record<SecurityKind, string> = {
  armed: Status.ok,
  disarmed: '#A4A7AC',
  tamper: Status.danger,
  motion: Status.warn,
  siren: Status.danger,
};

const CAMERA = { front: 'Front camera', rear: 'Rear camera' } as const;

export function entryLabel(entry: SecurityEntry) {
  return LABEL[entry.kind];
}

function when(ts: number) {
  const date = new Date(ts);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${time}`;
}

/** Security log rows in one card. Tapping a row opens it. */
export function SecurityEntryList({
  entries,
  onOpen,
}: {
  entries: SecurityEntry[];
  onOpen(entry: SecurityEntry): void;
}) {
  return (
    <Card style={styles.list}>
      {entries.map((entry, i) => (
        <Pressable
          key={entry.id}
          onPress={() => onOpen(entry)}
          accessibilityRole="button"
          style={[styles.row, i > 0 && styles.divider]}>
          <View style={[styles.dot, { backgroundColor: DOT[entry.kind] }]} />
          <View style={styles.grow}>
            <ThemedText numberOfLines={1}>{LABEL[entry.kind]}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
              {when(entry.ts)}
              {entry.place ? ` · ${entry.place}` : ''}
            </ThemedText>
          </View>
          {entry.pictures[0] && (
            <Image
              source={{ uri: pictureUri(entry.pictures[0].file) }}
              style={styles.thumb}
              contentFit="cover"
            />
          )}
        </Pressable>
      ))}
    </Card>
  );
}

/** One security entry in full: its pictures, time and place. Shown in a sheet. */
export function SecurityEntryDetail({
  entry,
  onClose,
  onDelete,
}: {
  entry: SecurityEntry;
  onClose(): void;
  onDelete(): void;
}) {
  const confirmDelete = () =>
    Alert.alert('Delete this entry?', 'Its pictures are deleted too. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: onDelete },
    ]);

  return (
    <SafeAreaView style={styles.sheet}>
      <View style={styles.sheetHeader}>
        <View style={styles.grow}>
          <ThemedText type="label">
            {new Date(entry.ts).toLocaleDateString([], {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
            })}{' '}
            ·{' '}
            {new Date(entry.ts).toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit',
              second: '2-digit',
            })}
          </ThemedText>
          <ThemedText type="subtitle" numberOfLines={1}>
            {LABEL[entry.kind]}
          </ThemedText>
        </View>
        <Button title="Done" size="small" variant="secondary" onPress={onClose} />
      </View>

      <ScrollView contentContainerStyle={styles.detail} showsVerticalScrollIndicator={false}>
        {entry.place && <ThemedText themeColor="textSecondary">Near {entry.place}</ThemedText>}

        {entry.pictures.length === 0 ? (
          <ThemedText themeColor="textSecondary">
            {entry.kind === 'tamper' || entry.kind === 'motion'
              ? 'No picture was saved. Pictures need a connected Velo with a camera, and the phone in range when it happens.'
              : 'No pictures are taken for this kind of entry.'}
          </ThemedText>
        ) : (
          entry.pictures.map((picture) => (
            <View key={picture.camera} style={styles.picture}>
              <Image
                source={{ uri: pictureUri(picture.file) }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
              />
              <Text style={styles.tag}>{CAMERA[picture.camera]}</Text>
            </View>
          ))
        )}

        {entry.pictures[0] && (
          <Button
            title="Share picture"
            onPress={() => {
              Share.share({ url: pictureUri(entry.pictures[0].file) }).catch(() => {});
            }}
          />
        )}
        <Button title="Delete entry" variant="secondary" onPress={confirmDelete} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  list: { gap: 0, paddingVertical: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingVertical: 10 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Hairline },
  dot: { width: 8, height: 8, borderRadius: 4 },
  grow: { flex: 1 },
  thumb: { width: 56, height: 42, borderRadius: 8, backgroundColor: '#F2F1ED' },
  sheet: { flex: 1, backgroundColor: '#F2F1ED', paddingHorizontal: Spacing.three },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.three,
  },
  detail: { gap: Spacing.three, paddingBottom: Spacing.six },
  picture: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#E8E7E2',
  },
  tag: {
    position: 'absolute',
    top: 10,
    left: 10,
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.6)',
    color: '#fff',
    fontFamily: Type.medium,
    fontSize: 11,
    letterSpacing: 0.8,
  },
});
