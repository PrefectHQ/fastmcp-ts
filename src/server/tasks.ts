export type TaskMode = 'forbidden' | 'optional' | 'required'

export interface TaskConfig {
  mode: TaskMode
  pollInterval: number
}

export type TaskInput = boolean | { mode?: TaskMode; pollInterval?: number }

export function resolveTaskConfig(task: TaskInput | undefined): TaskConfig {
  if (task === undefined || task === false) return { mode: 'forbidden', pollInterval: 5000 }
  if (task === true) return { mode: 'optional', pollInterval: 5000 }
  return { mode: task.mode ?? 'optional', pollInterval: task.pollInterval ?? 5000 }
}
