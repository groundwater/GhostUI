import { createContext } from '../lib/preact'

// Provides the current bundleId (or frontmost app bundleId for System-level nodes like menus)
export const AppContext = createContext('')
