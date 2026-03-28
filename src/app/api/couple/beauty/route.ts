import { createCoupleCrud } from '@/lib/api/couple-crud'

const crud = createCoupleCrud({
  table: 'makeup_schedule',
  allowedFields: ['person_name', 'role', 'hair_time', 'makeup_time', 'notes', 'sort_order'],
  orderBy: 'sort_order',
})

export const { GET, POST, PATCH, DELETE } = crud
