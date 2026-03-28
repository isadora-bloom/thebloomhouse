import { createCoupleCrud } from '@/lib/api/couple-crud'

const crud = createCoupleCrud({
  table: 'accommodations',
  allowedFields: [],
  orderBy: 'sort_order',
  readOnly: true,
})

export const { GET } = crud
