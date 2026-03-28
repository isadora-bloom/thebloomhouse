import { createCoupleCrud } from '@/lib/api/couple-crud'

const crud = createCoupleCrud({
  table: 'bedroom_assignments',
  allowedFields: ['room_name', 'room_description', 'guests', 'notes'],
  orderBy: 'created_at',
})

export const { GET, POST, PATCH, DELETE } = crud
