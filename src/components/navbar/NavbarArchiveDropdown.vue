<template>
  <b-nav-item-dropdown
    id="archive-dropdown"
    ref="dropdownRef"
    text="Archive"
    no-caret
    boundary="viewport"
  >
    <div>
      <BDropdownHeader>
        <div class="d-flex justify-content-between align-items-center w-100">
          <span>Archived Tasks</span>
          <BButton
            variant="light"
            size="sm"
            class="p-0"
            @click.stop="showDeleteModal = true"
          >
            <font-awesome-icon icon="trash-alt" />
          </BButton>
        </div>
      </BDropdownHeader>
      <BDropdownDivider />
      <template v-if="archivedTasks.length">
        <BDropdownItem
          v-for="task of archivedTasks"
          :key="task.id"
        >
          <div class="d-flex">
            <div class="flex-1 d-flex flex-wrap align-items-center">
              <CompleteStatus :completed="!!task.completed" class="me-2" />
              <span class="me-2 text-wrap">{{ task.name }}</span>
            </div>
            <div class="d-flex align-items-center">
              <div class="submenu-button-wrapper">
                <BButton
                  variant="light"
                  class="task-dropdown-item"
                  @click.stop="toggleSubmenu(task.id)"
                >
                  <font-awesome-icon icon="ellipsis-vertical" />
                </BButton>

                <!-- Submenu -->
                <div
                  class="submenu task-submenu"
                  :class="{ 'active': activeSubmenu === task.id }"
                >
                  <BDropdownItem @click="unarchiveTask(task.id)">
                    Restore
                  </BDropdownItem>
                </div>
              </div>
            </div>
          </div>
        </BDropdownItem>
      </template>

      <div
        v-if="archivedTasks.length === 0"
        disabled
      >
        <div class="d-flex flex-column align-items-center justify-content-center">
          <div class="empty-archive-state d-flex flex-column align-items-center justify-content-center">
            <img
              src="@/assets/icons/empty-white-box.svg"
              alt="Empty Archive"
              class="mb-2"
            >
            <span class="text-muted text-center">Archived tasks will appear here</span>
          </div>
        </div>
      </div>
    </div>
  </b-nav-item-dropdown>

  <!-- Delete Confirmation Modal -->
  <BModal
    id="delete-archived-modal"
    v-model="showDeleteModal"
    title="Delete All Archived Tasks"
    no-close-on-backdrop
    size="sm"
    ok-title="Delete All"
    cancel-title="Cancel"
    ok-variant="danger"
    @ok="handleDeleteAllArchived"
    @cancel="showDeleteModal = false"
  >
    <p class="mb-0">Are you sure you want to delete all {{ archivedTasks.length }} archived task{{ archivedTasks.length !== 1 ? 's' : '' }}? This action cannot be undone.</p>
  </BModal>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useStore } from 'vuex'
import CompleteStatus from '@/components/CompleteStatus.vue'
import type { Task } from '@/types' // Assuming Task type is available
import {
  BNavItemDropdown,
  BDropdownHeader,
  BDropdownDivider,
  BDropdownItem,
  BButton,
  BModal
} from 'bootstrap-vue-next'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'

// Store
const store = useStore()

// Refs
const dropdownRef = ref<InstanceType<typeof BNavItemDropdown> | null>(null)
const activeSubmenu = ref<string | null>(null)
const showDeleteModal = ref(false)

// Computed
const archivedTasks = computed<Task[]>(() => store.getters.archivedTasks)

// Methods
const toggleSubmenu = (taskId: string) => {
  dropdownRef.value?.show() // Keep dropdown open
  activeSubmenu.value = activeSubmenu.value === taskId ? null : taskId
}

const closeSubmenu = () => {
  activeSubmenu.value = null
}

const unarchiveTask = (taskId: string) => {
  store.dispatch('archiveTask', { taskId, archived: false })
  closeSubmenu()
}

const handleDeleteAllArchived = () => {
  store.dispatch('deleteAllArchivedTasks')
  showDeleteModal.value = false
  dropdownRef.value?.hide()
}

</script>

<style scoped>
.task-submenu {
  min-width: 10rem;
  text-align: left;
}

.empty-archive-state {
  height: 220px;
  width: 180px;
}
</style>

<style>
/*noinspection CssUnusedSymbol*/
#archive-dropdown-menu {
  min-width: 250px !important;
  max-width: 500px !important;
}

/*noinspection CssUnusedSymbol*/
.dropdown-header {
  text-align: left;
}

/*noinspection CssUnusedSymbol*/
#delete-archived-modal .modal-content {
  height: auto !important;
  max-height: none !important;
}
</style>
