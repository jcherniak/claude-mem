import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

const PremiumFeaturesContext = createContext(false)

export function PremiumFeaturesProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/settings', { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(settings => { if (!controller.signal.aborted) setEnabled(settings?.CLAUDE_MEM_PREMIUM_ENABLED === 'true') })
      .catch(() => {})
    return () => controller.abort()
  }, [])
  return <PremiumFeaturesContext.Provider value={enabled}>{children}</PremiumFeaturesContext.Provider>
}

export function usePremiumFeatures(): boolean {
  return useContext(PremiumFeaturesContext)
}
