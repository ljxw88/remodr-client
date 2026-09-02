import AsyncStorage from '@react-native-async-storage/async-storage';

import { JsonHostRepository } from '@/services/json-host-repository';

export const hostRepository = new JsonHostRepository(AsyncStorage);
