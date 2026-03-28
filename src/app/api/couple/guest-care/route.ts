import { createCoupleCrud } from '@/lib/api/couple-crud'

const crud = createCoupleCrud({
  table: 'guest_care_notes',
  allowedFields: ['guest_name', 'care_type', 'note'],
  orderBy: 'guest_name',
})

export const { GET, POST, PATCH, DELETE } = crud
