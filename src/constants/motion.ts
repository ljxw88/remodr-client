import { Easing } from 'react-native';

/** Carbon productive motion; navigation keeps the existing short in-page settle. */
export const Motion = {
  duration: {
    feedback: 70,
    fade: 110,
    reveal: 150,
    disclosure: 240,
    navigation: 200,
  },
  easing: {
    standard: Easing.bezier(0.2, 0, 0.38, 0.9),
    entrance: Easing.bezier(0, 0, 0.38, 0.9),
    exit: Easing.bezier(0.2, 0, 1, 0.9),
  },
} as const;
