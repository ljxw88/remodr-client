import { RouteStack } from '@/features/navigation/route-stack';

// The conversation floats a composer over its transcript, and that composer is
// the one piece of chrome in a pushed route that has something worth blurring.
export default function AgentsLayout() {
  return <RouteStack blurBackdrop />;
}
