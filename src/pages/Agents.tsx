// AGENTS — two views in one route component:
//   /agents      THE ARMS: roster of every agent + spawn panel
//   /agents/:id  AGENT DOSSIER: one agent's live state, full decision trace, pages kept
import { useParams } from 'react-router-dom'
import { ArmsView } from '@/components/agents/ArmsView'
import { Dossier } from '@/components/agents/Dossier'
import '@/components/obs/parts.css'
import './agents.css'

export default function Agents() {
  const { id } = useParams<{ id: string }>()
  return id === undefined ? <ArmsView /> : <Dossier idParam={id} />
}
