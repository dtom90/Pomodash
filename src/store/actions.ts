/* eslint-disable no-console */
import type { ActionContext } from 'vuex'
import type { PomoTrackState, Task, Tag, TaskLog, TaskTagMap, SettingKv } from '@/types'
import { nanoid } from 'nanoid'
// @ts-expect-error color-manager is not typed yet (TODO)
import ColorManager from 'color-manager'
import { toRaw } from 'vue'
import { storageEnabled, dexieDb } from './storageManager.ts'

interface TaskWithTags extends Task {
  tags?: string[]
}

// Helper function for Dexie calls
async function handleDexieError<T> (dexiePromise: Promise<T>, context = 'database operation', entity?: unknown): Promise<T> {
  try {
    if (!storageEnabled) {
      console.error(`Prevented operation due to low disk space. Operation: ${context}`)
      return Promise.reject()
    }
    return await dexiePromise
  } catch (error) {
    console.error(`Dexie error during ${context}:`, error, 'entity(ies):', entity)
    throw error
  }
}

const actions = {
  async loadInitialData ({ commit }: ActionContext<PomoTrackState, PomoTrackState>) {
    if (!dexieDb) return
    const tasks = await dexieDb.tasks.orderBy('order').toArray()
    // clear out any old task.tags. TODO: remove this once we've migrated to the new task tag system
    tasks.forEach((task) => {
      const taskWithTags = task as Partial<TaskWithTags>
      if (taskWithTags.tags) {
        delete taskWithTags.tags
      }
    })
    const tags = await dexieDb.tags.orderBy('order').toArray()
    const taskTagMaps = await dexieDb.taskTagMap.toArray()
    const settings = await dexieDb.settings.toArray()
    const logs = await dexieDb.logs.toArray()
    // If any logs were running but not stopped, stop them.
    for (const log of logs) {
      if (!log.stopped && log.timeSpent) {
        log.stopped = log.started + log.timeSpent
        await handleDexieError(dexieDb.logs.put(log), 'logs.put updateInterval', log)
      }
    }
    let selectedTaskLogs: TaskLog[] = []
    for (const setting of settings) {
      if (setting.key === 'selectedTaskID' && setting.value) {
        const selectedTaskID = setting.value as string
        selectedTaskLogs = await dexieDb.logs.where('taskId').equals(selectedTaskID).toArray()
      }
    }
    commit('loadInitialData', { tasks, tags, taskTagMaps, settings, selectedTaskLogs })
  },

  async loadAllActivity ({ commit }: ActionContext<PomoTrackState, PomoTrackState>) {
    if (!dexieDb) return
    const logs = await dexieDb.logs.orderBy('started').reverse().toArray()
    commit('setModalActivity', { logs })
  },

  async loadTagActivity ({ state, commit }: ActionContext<PomoTrackState, PomoTrackState>) {
    if (!dexieDb) return
    if (!state.tempState.modalTagId) {
      return
    }
    const taskMaps = await dexieDb.taskTagMap.where('tagId').equals(state.tempState.modalTagId).toArray()
    const taskIds = taskMaps.map(taskMap => taskMap.taskId)
    const logs = await dexieDb.logs.where('taskId').anyOf(taskIds).toArray()
    commit('setModalActivity', { logs })
  },

  async addTask ({ state, commit, dispatch }: ActionContext<PomoTrackState, PomoTrackState>, { name }: { name: string }) {
    if (!dexieDb) return
    const taskName = name.trim()
    if (taskName) {
      try {
        const order = Object.values(state.tasks).reduce((max, t) => t.order > max ? t.order : max, 0) + 1
        const newTask: Task = {
          id: 'task-' + nanoid(),
          name: taskName,
          notes: '',
          order,
          created_at: Date.now(),
          completed: undefined,
          archived: undefined
        }

        await handleDexieError(dexieDb.tasks.add(newTask), 'tasks.add', newTask)

        let taskTagMaps: TaskTagMap[] = []
        if (state.settings.addSelectedTags && state.settings.selectedTagIds.length) {
          taskTagMaps = state.settings.selectedTagIds.map((tagId: string) => ({
            id: 'taskTag-' + nanoid(),
            taskId: newTask.id,
            tagId
          }))
          await handleDexieError(dexieDb.taskTagMap.bulkAdd(taskTagMaps), 'taskTagMap.bulkAdd', taskTagMaps)
        }
        commit('addTask', { task: newTask, taskTagMaps })
        await dispatch('selectTask', { taskId: newTask.id })
      } catch (error) {
        console.error('Failed to complete addTask operation:', error)
      }
    }
  },

  async updateTaskName ({ state, commit }: ActionContext<PomoTrackState, PomoTrackState>, { taskId, name }: { taskId: string, name: string }) {
    if (!dexieDb) return
    try {
      const task = state.tasks[taskId]
      if (task) {
        const taskUpdates: Partial<Task> = { name }
        await handleDexieError(dexieDb.tasks.update(taskId, taskUpdates), 'tasks.update updateTaskName', { taskId, taskUpdates })
        commit('updateTask', { taskId, taskUpdates })
      }
    } catch (error) {
      console.error('Failed to update task name:', error)
    }
  },

  async updateTaskNotes ({ state, commit }: ActionContext<PomoTrackState, PomoTrackState>, { taskId, notes }: { taskId: string, notes: string }) {
    if (!dexieDb) return
    try {
      const task = state.tasks[taskId]
      if (task) {
        const taskUpdates: Partial<Task> = { notes }
        await handleDexieError(dexieDb.tasks.update(taskId, taskUpdates), 'tasks.update updateTaskNotes', { taskId, taskUpdates })
        commit('updateTask', { taskId, taskUpdates })
      }
    } catch (error) {
      console.error('Failed to update task notes:', error)
    }
  },

  async reorderIncompleteTasks ({ state, commit }: ActionContext<PomoTrackState, PomoTrackState>, { newIncompleteTaskOrder }: { newIncompleteTaskOrder: Task[] }) {
    if (!dexieDb) return

    async function bulkPutTasks (tasks: Task[]) {
      if (!dexieDb) return
      const tasksToPut = tasks.map(toRaw)
      await handleDexieError(dexieDb.tasks.bulkPut(tasksToPut), 'tasks.bulkPut reorder', tasksToPut)
      commit('setTasks', { tasks })
    }

    try {
      const incompleteTasks: Task[] = Object.values(state.tasks).filter(t => !t.completed)
      const completedTasks: Task[] = Object.values(state.tasks).filter(t => t.completed)
      const origLength = incompleteTasks.length
      if (newIncompleteTaskOrder.length === origLength) {
        const fullTaskOrder: Task[] = newIncompleteTaskOrder.concat(completedTasks)
        for (const [i, task] of fullTaskOrder.entries()) {
          task.order = i
        }
        await bulkPutTasks(fullTaskOrder)
      } else {
        const reorderTaskIds: { [key: string]: boolean } = {}
        newIncompleteTaskOrder.forEach(task => {
          reorderTaskIds[task.id] = true
        })
        let r = 0
        for (let i = 0; i < incompleteTasks.length; i++) {
          if (incompleteTasks[i].id in reorderTaskIds) {
            incompleteTasks[i] = newIncompleteTaskOrder[r]
            r++
          }
        }
        if (incompleteTasks.length === origLength) { // ensure that the length has not changed
          const fullTaskOrder: Task[] = incompleteTasks.concat(completedTasks)
          for (const [i, task] of fullTaskOrder.entries()) {
            task.order = i
          }
          await bulkPutTasks(fullTaskOrder)
        }
      }
    } catch (error) {
      console.error('Failed to complete reorderIncompleteTasks operation:', error)
    }
  },

  async startTask ({ state, commit, dispatch }: ActionContext<PomoTrackState, PomoTrackState>, { taskId }: { taskId: string }) {
    if (!dexieDb) return
    try {
      await dispatch('stopTask')

      const task = state.tasks[taskId]
      if (task) {
        const log: TaskLog = {
          id: 'log-' + nanoid(),
          taskId,
          started: Date.now(),
          stopped: null,
          timeSpent: null
        }
        await handleDexieError(dexieDb.logs.add(log), 'logs.add startTask', log)
        commit('startTask', { log })
      }
    } catch (error) {
      console.error('Failed to start task:', error)
    }
  },

  async updateTaskTimer ({ state, commit }: ActionContext<PomoTrackState, PomoTrackState>, { taskId }: { taskId: string }) {
    if (!dexieDb) return
    try {
      const task = state.tasks[taskId]
      if (task) {
        const runningLog = await dexieDb.logs.where('taskId').equals(taskId).and(log => log.stopped == null).first()
        if (runningLog) {
          runningLog.timeSpent = Date.now() - runningLog.started
          await handleDexieError(dexieDb.logs.put(runningLog), 'logs.put updateTaskTimer', runningLog)
          commit('updateLog', { taskId, log: runningLog })
        }
      }
    } catch (error) {
      console.error('Failed to update task timer:', error)
    }
  },

  async stopTask ({ commit }: ActionContext<PomoTrackState, PomoTrackState>) {
    if (!dexieDb) return
    try {
      const runningLog = await dexieDb.logs.filter(log => log.stopped === null).first()
      if (runningLog) {
        runningLog.stopped = Date.now()
        runningLog.timeSpent = runningLog.stopped - runningLog.started
        await handleDexieError(dexieDb.logs.put(runningLog), 'logs.put stopTask', runningLog)
        commit('updateLog', { taskId: runningLog.taskId, log: runningLog })
      }
    } catch (error) {
      console.error('Failed to stop task:', error)
    }
  },

  async completeTask ({ state, commit, dispatch }: ActionContext<PomoTrackState, PomoTrackState>, { taskId }: { taskId: string }) {
    if (!dexieDb) return
    const task = state.tasks[taskId]
    if (task) {
      let completedValue = undefined
      if (!task.completed) {
        if (task.id === state.tempState.activeTaskID && state.tempState.running) {
          await dispatch('stopTask')
        }
        completedValue = Date.now()
      }
      const taskUpdates = { completed: completedValue }
      await dexieDb.tasks.update(taskId, taskUpdates)
      commit('updateTask', { taskId, taskUpdates })
    }
  },

  async archiveTask ({ state, commit }: ActionContext<PomoTrackState, PomoTrackState>, { taskId }: { taskId: string }) {
    if (!dexieDb) return
    const task = state.tasks[taskId]
    if (task) {
      const taskUpdates = { archived: !task.archived }
      await dexieDb.tasks.update(taskId, taskUpdates)
      commit('updateTask', { taskId, taskUpdates })
    }
  },

  async archiveTasks ({ getters, commit }: ActionContext<PomoTrackState, PomoTrackState>) {
    if (!dexieDb) return
    const completedTasks: Task[] = getters.completedTasksFiltered.filter((t: Task) => !t.archived)
    if (completedTasks.length === 0) {
      alert('No completed tasks to archive')
      return
    }
    if (completedTasks.length === 1 || confirm(`Are you sure that you want to archive all ${completedTasks.length} completed tasks?`)) {
      const taskIds = completedTasks.map(task => task.id)
      await handleDexieError(dexieDb.tasks.where('id').anyOf(taskIds).modify({ archived: true }), 'tasks.modify archiveTasks', { taskIds })

      const tasksToUpdate = await dexieDb.tasks.where('id').anyOf(taskIds).toArray()
      commit('updateTasks', { tasksToUpdate })
    }
  },

  async addInterval ({ state, commit }: ActionContext<PomoTrackState, PomoTrackState>, { taskId, started, timeSpent, stopped }: { taskId: string, started: number, timeSpent: number, stopped: number }) {
    if (!dexieDb) return
    const task = state.tasks[taskId]
    if (task) {
      const log = {
        id: 'log-' + nanoid(),
        taskId,
        started,
        timeSpent,
        stopped
      } as TaskLog
      await dexieDb.logs.add(log)
      commit('updateLog', { taskId, log })
    }
  },

  async getLogById ({ }, { logId }: { logId: string }): Promise<TaskLog | undefined> {
    if (!dexieDb) return
    return await dexieDb.logs.where('id').equals(logId).first()
  },

  async updateInterval ({ commit }: ActionContext<PomoTrackState, PomoTrackState>, { logId, started, timeSpent, stopped }: { logId: string, started: number, timeSpent: number, stopped: number }) {
    if (!dexieDb) return
    try {
      const log = await dexieDb.logs.get(logId)
      if (log) {
        log.started = started
        log.stopped = stopped
        log.timeSpent = timeSpent
        await handleDexieError(dexieDb.logs.put(log), 'logs.put updateInterval', log)
        commit('updateLog', { taskId: log.taskId, log })
      }
    } catch (error) {
      console.error('Failed to update interval:', error)
    }
  },

  async deleteInterval ({ commit }: ActionContext<PomoTrackState, PomoTrackState>, { logId }: { logId: string }) {
    if (!dexieDb) return
    try {
      const log = await dexieDb.logs.get(logId)
      if (log) {
        await handleDexieError(dexieDb.logs.delete(logId), 'logs.delete deleteInterval', { logId })
        commit('deleteInterval', { taskId: log.taskId, logId })
      }
    } catch (error) {
      console.error('Failed to delete interval:', error)
    }
  },

  async addTaskTagByName ({ state, commit }: ActionContext<PomoTrackState, PomoTrackState>, { taskId, tagName }: { taskId: string, tagName: string }) {
    if (!dexieDb) return
    try {
      const trimmedTagName = tagName.trim()
      if (trimmedTagName) {
        const task = state.tasks[taskId]
        if (task) {
          let tag = await dexieDb.tags.where('tagName').equals(trimmedTagName).first()
          const isNewTag = !tag
          if (!tag) {
            const colors = Object.values(state.tags).map(tag => tag.color)
            const colorManager = new ColorManager(colors)
            const maxOrder = await dexieDb.tags.orderBy('order').last()
            const order = maxOrder ? maxOrder.order + 1 : 0
            tag = {
              id: 'tag-' + nanoid(),
              tagName: trimmedTagName,
              color: colorManager.getRandomColor(),
              order
            }
            await dexieDb.tags.add(tag)
          }
          await dexieDb.taskTagMap.add({
            id: 'taskTag-' + nanoid(),
            taskId,
            tagId: tag.id
          })
          commit('addTaskTag', { taskId, tag, isNewTag })
        }
      }
    } catch (error) {
      console.error('Failed to add task tag by name:', error)
    }
  },

  async addTaskTagById ({ state, commit }: ActionContext<PomoTrackState, PomoTrackState>, { taskId, tagId }: { taskId: string, tagId: string }) {
    if (!dexieDb) return
    const task = state.tasks[taskId]
    const tag = state.tags[tagId]
    if (task && tag) {
      await handleDexieError(dexieDb.taskTagMap.add({
        id: 'taskTag-' + nanoid(),
        taskId,
        tagId
      }), 'taskTagMap.add addTaskTagById', { taskId, tagId })
      commit('addTaskTag', { taskId, tag, isNewTag: false })
    }
  },

  async updateTag ({ commit }: ActionContext<PomoTrackState, PomoTrackState>, { tagId, ...tagUpdates }: { tagId: string } & Partial<Tag>) {
    if (!dexieDb) return
    const tag = await dexieDb.tags.where('id').equals(tagId).first()
    if (!tag) {
      alert('Error: the tag you are trying to update does not exist. Please refresh the page and try again.')
      return
    }

    if ('tagName' in tagUpdates && tagUpdates.tagName) {
      const existingTagWithName = await dexieDb.tags
        .where('tagName').equals(tagUpdates.tagName)
        .and(tag => tag.id !== tagId)
        .first()
      if (existingTagWithName) {
        alert('Error: the new tag name you entered already exists. Please rename it to something else.')
        return
      }
    }

    await handleDexieError(dexieDb.tags.update(tagId, tagUpdates), 'tags.update updateTag', { tagId, tagUpdates })

    commit('updateTag', { tagId, tagUpdates })
  },

  async reorderTags ({ state, commit }: ActionContext<PomoTrackState, PomoTrackState>, { newOrder }: { newOrder: string[] }) {
    if (!dexieDb) return
    const reorderedTags: Tag[] = []
    for (const [i, tagId] of newOrder.entries()) {
      const tag = state.tags[tagId]
      if (tag.order !== i) {
        tag.order = i
      }
      reorderedTags.push(toRaw(tag))
    }
    await handleDexieError(dexieDb.tags.bulkPut(reorderedTags), 'tags.bulkPut reorder', reorderedTags)
    commit('updateTagOrder', { reorderedTags })
  },

  async removeTaskTag ({ commit }: ActionContext<PomoTrackState, PomoTrackState>, { taskId, tagId }: { taskId: string, tagId: string }) {
    if (!dexieDb) return
    await dexieDb.taskTagMap
      .where('taskId').equals(taskId)
      .and((taskTagMap: TaskTagMap) => taskTagMap.tagId === tagId)
      .delete()

    const newTags = await dexieDb.taskTagMap.where('taskId').equals(taskId).toArray()
    const newTagIds = newTags.map(tag => tag.tagId)
    commit('deleteTaskTag', { taskId, newTagIds })
  },

  async deleteTag ({ commit }: ActionContext<PomoTrackState, PomoTrackState>, { tagId }: { tagId: string }) {
    if (!dexieDb) return
    const tag = await dexieDb.tags.where('id').equals(tagId).first()
    if (!tag) return
    if (confirm(`Are you sure you want to delete the tag "${tag.tagName}"?\nAll tasks with this tag will lose the tag.`)) {
      await handleDexieError(dexieDb.taskTagMap.where('tagId').equals(tagId).delete(), 'taskTagMap.delete deleteTag', { tagId })
      await handleDexieError(dexieDb.tags.where('id').equals(tagId).delete(), 'tags.delete deleteTag', { tagId })
      commit('deleteTag', { tagId })
    }
  },

  async selectTask ({ dispatch, commit }: ActionContext<PomoTrackState, PomoTrackState>, { taskId }: { taskId: string | null }) {
    if (!dexieDb) return
    await dispatch('updateSetting', { key: 'selectedTaskID', value: taskId })
    if (taskId) {
      const selectedTaskLogs = await dexieDb.logs.where('taskId').equals(taskId).toArray()
      commit('setSelectedTaskLogs', { selectedTaskLogs })
    } else {
      commit('setSelectedTaskLogs', { selectedTaskLogs: [] })
    }
  },

  async addTagFilter ({ state, dispatch }: ActionContext<PomoTrackState, PomoTrackState>, { tagId }: { tagId: string }) {
    if (!dexieDb) return
    const selectedTagIds = state.settings.selectedTagIds
    selectedTagIds.push(tagId)
    await dispatch('updateSetting', { key: 'selectedTagIds', value: selectedTagIds })
  },

  async removeTagFilter ({ state, dispatch }: ActionContext<PomoTrackState, PomoTrackState>, { tagId }: { tagId: string }) {
    if (!dexieDb) return
    const selectedTagIds = state.settings.selectedTagIds.filter(selectedTagId => selectedTagId !== tagId)
    await dispatch('updateSetting', { key: 'selectedTagIds', value: selectedTagIds })
  },

  async updateSetting ({ commit }: ActionContext<PomoTrackState, PomoTrackState>, { key, value }: SettingKv) {
    if (!dexieDb) return
    await handleDexieError(dexieDb.settings.put({ key, value: toRaw(value) }), 'settings.put', { key, value: toRaw(value) })
    commit('updateSetting', { key, value })
  },

  async removeAllTagFilters ({ dispatch }: ActionContext<PomoTrackState, PomoTrackState>) {
    if (!dexieDb) return
    await handleDexieError(dexieDb.settings.put({ key: 'selectedTagIds', value: [] }), 'settings.put removeAllTagFilters')
    await dispatch('updateSetting', { key: 'selectedTagIds', value: [] })
  },

  openActivityModal ({ state, commit, dispatch }: ActionContext<PomoTrackState, PomoTrackState>) {
    if (!dexieDb) return
    if (!state.tempState.modalTagId) {
      dispatch('loadAllActivity')
    } else {
      dispatch('loadTagActivity')
    }
    commit('setActivityModalVisible', true)
  },

  closeActivityModal ({ commit }: ActionContext<PomoTrackState, PomoTrackState>) {
    if (!dexieDb) return
    commit('setActivityModalVisible', false)
  },

  async deleteAllArchivedTasks ({ getters, commit }: ActionContext<PomoTrackState, PomoTrackState>) {
    if (!dexieDb) return
    const archivedTasks: Task[] = getters.archivedTasks
    if (archivedTasks.length === 0) {
      return
    }
    const taskIds = archivedTasks.map(task => task.id)

    // Delete task logs
    await handleDexieError(
      dexieDb.logs.where('taskId').anyOf(taskIds).delete(),
      'logs.delete deleteAllArchivedTasks',
      { taskIds }
    )

    // Delete task tag maps
    await handleDexieError(
      dexieDb.taskTagMap.where('taskId').anyOf(taskIds).delete(),
      'taskTagMap.delete deleteAllArchivedTasks',
      { taskIds }
    )

    // Delete tasks
    await handleDexieError(
      dexieDb.tasks.where('id').anyOf(taskIds).delete(),
      'tasks.delete deleteAllArchivedTasks',
      { taskIds }
    )

    commit('deleteTasks', { taskIds })
  }
}

export default actions
