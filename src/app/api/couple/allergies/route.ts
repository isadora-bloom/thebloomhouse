import { createCoupleCrud } from '@/lib/api/couple-crud'

const crud = createCoupleCrud({
  table: 'allergy_registry',
  allowedFields: ['guest_name', 'allergy_type', 'severity', 'notes', 'is_important'],
  orderBy: 'guest_name',
})

export const { GET, POST, PATCH, DELETE } = crud
