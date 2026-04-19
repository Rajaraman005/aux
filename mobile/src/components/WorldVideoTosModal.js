/**
 * WorldVideoTosModal — Terms of Service acknowledgment gate.
 *
 * Required before first World Video entry.
 * Re-gates on version update (currentVersion in server config).
 */
import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ScrollView,
} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import { colors, typography, spacing, radius, shadows } from '../styles/theme';

const CURRENT_TOS_VERSION = '1.0';

const TOS_CONTENT = [
  'You will be connected with random strangers via live video.',
  'Do not share personal information with people you don\'t know.',
  'Nudity, harassment, and illegal content are strictly prohibited.',
  'You can skip to the next person at any time by tapping "Next".',
  'Each session lasts a maximum of 3 minutes.',
  'You can report users who violate community guidelines.',
  'You must be 18 years or older to use this feature.',
  'Your video may be monitored for safety purposes.',
];

export default function WorldVideoTosModal({ visible, onAccept, onDecline }) {
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.overlay}>
        <View style={styles.container}>
          <View style={styles.iconWrap}>
            <Icon name="video" size={32} color={colors.primary} />
          </View>

          <Text style={styles.title}>Random Video Chat</Text>
          <Text style={styles.subtitle}>Before you begin, please review:</Text>

          <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
            {TOS_CONTENT.map((item, index) => (
              <View key={index} style={styles.ruleRow}>
                <Text style={styles.ruleBullet}>•</Text>
                <Text style={styles.ruleText}>{item}</Text>
              </View>
            ))}
          </ScrollView>

          <Text style={styles.versionText}>
            Terms v{CURRENT_TOS_VERSION}
          </Text>

          <TouchableOpacity style={styles.acceptButton} onPress={onAccept} activeOpacity={0.8}>
            <Text style={styles.acceptText}>I Agree — Continue</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.declineButton} onPress={onDecline} activeOpacity={0.8}>
            <Text style={styles.declineText}>Not Now</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  container: {
    backgroundColor: colors.bg,
    borderRadius: radius.lg,
    padding: spacing.xl,
    width: '100%',
    maxWidth: 420,
    ...shadows.lg,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.bgElevated,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
    marginBottom: spacing.md,
  },
  title: {
    ...typography.h2,
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  subtitle: {
    ...typography.bodySmall,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  scrollView: {
    maxHeight: 220,
    marginBottom: spacing.md,
  },
  scrollContent: {
    paddingBottom: spacing.sm,
  },
  ruleRow: {
    flexDirection: 'row',
    marginBottom: spacing.sm,
    paddingLeft: spacing.sm,
  },
  ruleBullet: {
    fontSize: 14,
    color: colors.primary,
    marginRight: spacing.sm,
    marginTop: 2,
  },
  ruleText: {
    ...typography.body,
    flex: 1,
    lineHeight: 20,
  },
  versionText: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  acceptButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  acceptText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  declineButton: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  declineText: {
    color: colors.textMuted,
    fontSize: 15,
    fontWeight: '500',
  },
});