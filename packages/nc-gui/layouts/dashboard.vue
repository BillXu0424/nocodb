<script lang="ts" setup>
const router = useRouter()
const route = router.currentRoute

// 当 route.meta.hasSidebar 为真，或处于 base 内视图（有 baseId）时渲染 LazyDashboardView
// 生产构建中 meta 合并可能不一致，用 baseId 作为兜底确保表格视图能显示 AI 侧边栏
const shouldShowDashboardView = computed(
  () => !!route.value.meta.hasSidebar || !!route.value.params.baseId,
)
</script>

<script lang="ts">
export default {
  name: 'DashboardLayout',
}
</script>

<template>
  <NuxtLayout>
    <slot v-if="!shouldShowDashboardView" name="content" />

    <LazyDashboardView v-else>
      <template #sidebar>
        <slot name="sidebar" />
      </template>
      <template #content>
        <slot name="content" />
      </template>
    </LazyDashboardView>
  </NuxtLayout>
</template>
