import { createContext, type RefObject } from 'react';
import type { LayoutRectangle } from 'react-native';

/** Window coordinates of the nearest scroll viewport, updated without rerendering its rows. */
export const ScrollViewportContext = createContext<RefObject<LayoutRectangle | null> | null>(null);
