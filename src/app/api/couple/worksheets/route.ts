import { createCoupleCrud } from '@/lib/api/couple-crud'

const crud = createCoupleCrud({
  table: 'wedding_worksheets',
  allowedFields: ['section', 'content'],
  orderBy: 'section',
})

export const { GET, POST, PATCH, DELETE } = crud
