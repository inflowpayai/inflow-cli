import { Text } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';

interface ProgressViewProps {
  message: string;
}

export const ProgressView: React.FC<ProgressViewProps> = ({ message }) => (
  <Text color="cyan">
    <Spinner type="dots" /> {message}
  </Text>
);
