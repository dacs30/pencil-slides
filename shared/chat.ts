export type ToolActivity = {
  id: string
  name: string
  status: 'running' | 'complete' | 'failed' | 'interrupted'
  error?: string
  revision?: number
}
export type SlideArtifact = {
  title: string
  revision: number
  slideIds: string[]
}
export type ChatDetails = { activities?: ToolActivity[]; artifacts?: SlideArtifact[] }
export type ChatMessage = ChatDetails & { role: 'user' | 'assistant'; content: string; runState?: 'running' | 'complete' | 'interrupted' }
