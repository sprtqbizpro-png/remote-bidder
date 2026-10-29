import { Router } from 'express';
import {
  requireOwner,
  listMembers,
  createMember,
  updateMember,
  deleteMember,
} from '../userAuth.js';

const router = Router();

router.get('/', (req, res) => {
  if (!requireOwner(req, res)) return;
  res.json(listMembers());
});

router.post('/', (req, res) => {
  if (!requireOwner(req, res)) return;
  try {
    const { email, password, name } = req.body || {};
    const member = createMember({ email, password, name });
    res.status(201).json({ ok: true, member });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  if (!requireOwner(req, res)) return;
  try {
    const { email, password, name } = req.body || {};
    const member = updateMember(req.params.id, { email, password, name });
    res.json({ ok: true, member });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  if (!requireOwner(req, res)) return;
  try {
    deleteMember(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
