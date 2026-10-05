import { useEffect, useRef } from 'react'
import { bus } from '@/lib/bus'
import { useLive } from '@/lib/store'
import { CreatureScene, type CreatureVariant } from './CreatureScene'
import './creature.css'

export interface CreatureProps {
  variant?: CreatureVariant
  interactive?: boolean
  labels?: boolean
  selected?: number | null
  onSelect?: (id: number | null) => void
  className?: string
}

/**
 * React host for the LUSCA creature. The scene is imperative: it is seeded from
 * the store once and then fed straight from the event bus, so React never
 * re-renders on the hot path. Its motion is decorative; every count it prints
 * comes from the server and reads "—" while there is no link.
 */
export function Creature({ variant = 'observatory', interactive = false, labels = false, selected = null, onSelect, className }: CreatureProps) {
  const host = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const scene = useRef<CreatureScene | null>(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  useEffect(() => {
    if (!host.current) return
    let sc: CreatureScene
    try {
      sc = new CreatureScene(host.current, {
        variant,
        interactive,
        labels,
        onSelect: (id) => onSelectRef.current?.(id),
      })
    } catch (e) {
      console.error('[lusca] WebGL unavailable', e)
      host.current.dataset.nogl = '1'
      return
    }
    scene.current = sc
    sc.setLabelLayer(layer.current)
    const st = useLive.getState()
    sc.reset(st.agents, st.pages, Object.values(st.domains))
    sc.setSectorCounts(st.conn === 'live' ? st.sectors : null)
    const off = bus.any((m) => sc.handle(m))
    // link lost: the store was emptied; the scene must not keep drawing the old swarm
    const offConn = useLive.subscribe((s, prev) => {
      if (prev.conn === 'live' && s.conn !== 'live') sc.clear()
    })
    return () => {
      off()
      offConn()
      sc.dispose()
      scene.current = null
    }
  }, [variant, interactive, labels])

  useEffect(() => {
    scene.current?.select(selected)
  }, [selected])

  return (
    <div className={`creature ${className ?? ''}`}>
      <div ref={host} className="creature-gl" />
      <div ref={layer} className="creature-labels" aria-hidden="true" />
    </div>
  )
}
