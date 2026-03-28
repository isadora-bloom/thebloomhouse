import { createCoupleCrud } from '@/lib/api/couple-crud'

const crud = createCoupleCrud({
  table: 'rehearsal_dinner',
  allowedFields: ['location_name', 'address', 'date', 'start_time', 'end_time', 'guest_count', 'menu_notes', 'special_arrangements'],
  orderBy: 'created_at',
})

export const { GET, POST, PATCH, DELETE } = crud
