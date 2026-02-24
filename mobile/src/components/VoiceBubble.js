import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import Icon from "react-native-vector-icons/Feather";
import { Audio } from "expo-av";
import { colors } from "../styles/theme";

function formatDuration(millis) {
  if (!millis) return "0:00";
  const totalSeconds = Math.floor(millis / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function VoiceBubble({
  uri,
  duration,
  isMine,
  isUploading,
  footer,
}) {
  const [sound, setSound] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [currentUri, setCurrentUri] = useState(uri);

  // If the audio URI changes (e.g. from a local optimistic file to a CDN URL)
  // we must unload the old sound and reset our state to prepare for the new file.
  if (uri !== currentUri) {
    if (sound) {
      sound.unloadAsync().catch(() => {});
    }
    setSound(null);
    setIsPlaying(false);
    setPosition(0);
    setCurrentUri(uri);
  }

  const estimatedDuration = duration ? duration * 1000 : 0;
  const displayDuration = sound ? position : estimatedDuration;

  // Generate fake deterministic waveform pattern for visualization
  const NUM_BARS = 30;
  const waveform = useMemo(() => {
    // Looks like sound waves
    const pattern = [
      0.3, 0.4, 0.7, 1.0, 0.8, 0.5, 0.3, 0.6, 0.9, 0.4, 0.3, 0.7, 1.0, 0.9, 0.5,
      0.4, 0.6, 0.8, 0.5, 0.3, 0.7, 0.5, 0.4, 0.9, 1.0, 0.6, 0.3, 0.5, 0.8, 0.5,
    ];
    return Array.from({ length: NUM_BARS }).map(
      (_, i) => pattern[i % pattern.length],
    );
  }, []);

  const onPlaybackStatusUpdate = useCallback(
    (status) => {
      if (status.isLoaded) {
        setPosition(status.positionMillis);
        setIsPlaying(status.isPlaying);
        if (status.didJustFinish) {
          setIsPlaying(false);
          setPosition(0);
        }
      } else {
        if (status.error) {
          console.error("Audio playback error:", status.error);
        }
      }
    },
    [sound],
  );

  const togglePlayback = async () => {
    if (isUploading) return;

    try {
      if (sound) {
        if (isPlaying) {
          await sound.pauseAsync();
        } else {
          const status = await sound.getStatusAsync();
          if (status.positionMillis === status.durationMillis) {
            await sound.setPositionAsync(0);
          }
          await sound.playAsync();
        }
      } else {
        // Load and play
        setIsLoading(true);
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          allowsRecordingIOS: false,
        });

        const { sound: newSound } = await Audio.Sound.createAsync(
          { uri },
          { shouldPlay: true, progressUpdateIntervalMillis: 50 },
          onPlaybackStatusUpdate,
        );
        setSound(newSound);
        setIsLoading(false);
      }
    } catch (err) {
      console.error("VoiceBubble toggle error:", err);
      // If Expo AV unloaded the sound under the hood, or the file is missing
      if (err.message && err.message.includes("not loaded")) {
        setSound(null);
        setIsPlaying(false);
        setPosition(0);
      }
      setIsLoading(false);
    }
  };

  useEffect(() => {
    return sound
      ? () => {
          sound.unloadAsync();
        }
      : undefined;
  }, [sound]);

  const progressPercent =
    sound && estimatedDuration > 0 ? position / estimatedDuration : 0;

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {/* Play / Pause / Load Button */}
        <TouchableOpacity
          style={[
            styles.playButton,
            isMine ? styles.playButtonMine : styles.playButtonTheirs,
          ]}
          onPress={togglePlayback}
          disabled={isUploading || isLoading}
        >
          {isUploading || isLoading ? (
            <ActivityIndicator
              size="small"
              color={isMine ? colors.primary : "#fff"}
            />
          ) : (
            <Icon
              name={isPlaying ? "pause" : "play"}
              size={18}
              color={isMine ? colors.primary : "#fff"}
              style={{ marginLeft: isPlaying ? 0 : 2 }} // center the play triangle
            />
          )}
        </TouchableOpacity>

        {/* Waveform Visualization */}
        <View style={styles.waveformContainer}>
          {waveform.map((val, index) => {
            const barStart = index / NUM_BARS;
            const barEnd = (index + 1) / NUM_BARS;

            let fillPercent = 0;
            if (progressPercent >= barEnd) fillPercent = 100;
            else if (progressPercent > barStart) {
              fillPercent =
                ((progressPercent - barStart) / (barEnd - barStart)) * 100;
            }

            const barHeight = Math.max(4, 28 * val);

            return (
              <View
                key={index}
                style={[
                  styles.waveformBar,
                  { height: barHeight, overflow: "hidden" },
                  isMine ? styles.barUnplayedMine : styles.barUnplayedTheirs,
                ]}
              >
                <View
                  style={[
                    StyleSheet.absoluteFill,
                    isMine ? styles.barPlayedMine : styles.barPlayedTheirs,
                    { width: `${fillPercent}%` },
                  ]}
                />
              </View>
            );
          })}
        </View>
      </View>

      {/* Footer Row (Duration + Message Timestamp) */}
      <View style={styles.footerRow}>
        <Text
          style={[
            styles.timeText,
            isMine ? styles.timeMine : styles.timeTheirs,
          ]}
        >
          {formatDuration(
            displayDuration > 0 ? displayDuration : estimatedDuration,
          )}
        </Text>
        {footer}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: 4,
    width: 210, // Gives enough width for a good looking waveform
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  playButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 10,
  },
  playButtonMine: {
    backgroundColor: "#fff",
  },
  playButtonTheirs: {
    backgroundColor: colors.primary,
  },
  waveformContainer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    height: 30, // To center the bars vertically
  },
  waveformBar: {
    width: 3,
    borderRadius: 2,
  },
  barPlayedMine: {
    backgroundColor: "#fff",
  },
  barUnplayedMine: {
    backgroundColor: "rgba(255, 255, 255, 0.4)",
  },
  barPlayedTheirs: {
    backgroundColor: colors.primary,
  },
  barUnplayedTheirs: {
    backgroundColor: "rgba(0, 0, 0, 0.15)",
  },
  footerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginLeft: 48, // Aligned under the waveform
    marginTop: 4,
  },
  timeText: {
    fontSize: 11,
    fontWeight: "500",
  },
  timeMine: {
    color: "rgba(255, 255, 255, 0.8)",
  },
  timeTheirs: {
    color: colors.textSecondary,
  },
});
