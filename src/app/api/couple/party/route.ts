import { createCoupleCrud } from '@/lib/api/couple-crud'

const crud = createCoupleCrud({
  table: 'wedding_party',
  allowedFields: ['name', 'role', 'side', 'relationship', 'bio', 'photo_url', 'sort_order'],
  orderBy: 'sort_order',
})

export const { GET, POST, PATCH, DELETE } = crud
