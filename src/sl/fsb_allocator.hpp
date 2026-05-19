//+++HDR+++
//======================================================================
//  This file is part of the SL software library.
//
//  Copyright (C) 1993-2010 by Enrico Gobbetti (gobbetti@crs4.it)
//  Copyright (C) 1996-2010 by CRS4 Visual Computing Group, Pula, Italy
//
//  For more information, visit the CRS4 Visual Computing Group 
//  web pages at http://www.crs4.it/vvr/.
//
//  This file may be used under the terms of the GNU General Public
//  License as published by the Free Software Foundation and appearing
//  in the file LICENSE included in the packaging of this file.
//
//  CRS4 reserves all rights not expressly granted herein.
//  
//  This file is provided AS IS with NO WARRANTY OF ANY KIND, 
//  INCLUDING THE WARRANTY OF DESIGN, MERCHANTABILITY AND FITNESS 
//  FOR A PARTICULAR PURPOSE.
//
//======================================================================
//---HDR---//
/*===========================================================================
  This library is released under the MIT license. See FSBAllocator.html
  for further information and documentation.

  Copyright (c) 2008 Juha Nieminen

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in
  all copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
  THE SOFTWARE.
  =============================================================================*/

#ifndef _SL_FSB_ALLOCATOR_HPP
#define _SL_FSB_ALLOCATOR_HPP

#include <cstdlib> // abort
#include <new>
#include <cassert>
#include <vector>

namespace sl {

  template<unsigned ElemSize>
  class fsb_allocator_elem_allocator {
    typedef std::size_t data_t;
    static const data_t BlockElements = 512;

    static const data_t DSize = sizeof(data_t);
    static const data_t ElemSizeInDSize = (ElemSize + (DSize-1)) / DSize;
    static const data_t UnitSizeInDSize = ElemSizeInDSize + 1;
    static const data_t BlockSize = BlockElements*UnitSizeInDSize;

    class mem_block {
      data_t* block;
      data_t firstFreeUnitIndex, allocatedElementsAmount, endIndex;
    public:
      mem_block():
	block(0),
	firstFreeUnitIndex(data_t(-1)),
	allocatedElementsAmount(0) {
      }

      bool isFull() const {
	return allocatedElementsAmount == BlockElements;
      }

      void clear()
      {
	delete[] block;
	block = 0;
	firstFreeUnitIndex = data_t(-1);
      }

      void* allocate(data_t vectorIndex) {
	if (firstFreeUnitIndex == data_t(-1)) {
	  if(!block) {
	    block = new data_t[BlockSize];
	    if (!block) return 0;
	    endIndex = 0;
	  }

	  data_t* retval = block + endIndex;
	  endIndex += UnitSizeInDSize;
	  retval[ElemSizeInDSize] = vectorIndex;
	  ++allocatedElementsAmount;
	  return retval;
	} else {
	  data_t* retval = block + firstFreeUnitIndex;
	  firstFreeUnitIndex = *retval;
	  ++allocatedElementsAmount;
	  return retval;
	}
      }

      void deallocate(data_t* ptr) {
	*ptr = firstFreeUnitIndex;
	firstFreeUnitIndex = ptr - block;
	
	if(--allocatedElementsAmount == 0)
	  clear();
      }
    };

    struct BlocksVector
    {
      std::vector<mem_block> data;

      BlocksVector() { data.reserve(1024); }

      ~BlocksVector() {
	for(size_t i = 0; i < data.size(); ++i)
	  data[i].clear();
      }
    };

    static BlocksVector blocksVector;
    static std::vector<data_t> blocksWithFree;

#ifdef SL_FSBALLOCATOR_USE_THREAD_SAFE_LOCKING_GCC
    volatile static int lockFlag;

    struct Lock {
      Lock() { while(!__sync_bool_compare_and_swap(&lockFlag, 0, 1)); }
      ~Lock() { lockFlag = 0; }
    };
#endif

  public:
    static void* allocate()
    {
#ifdef SL_FSBALLOCATOR_USE_THREAD_SAFE_LOCKING_GCC
      Lock lock;
#endif

      if(blocksWithFree.empty())
        {
	  blocksWithFree.push_back(blocksVector.data.size());
	  blocksVector.data.push_back(mem_block());
        }

      const data_t index = blocksWithFree.back();
      mem_block& block = blocksVector.data[index];
      void* retval = block.allocate(index);

      if(block.isFull())
	blocksWithFree.pop_back();

      return retval;
    }

    static void deallocate(void* ptr)
    {
      if(!ptr) return;

#ifdef SL_FSBALLOCATOR_USE_THREAD_SAFE_LOCKING_GCC
      Lock lock;
#endif

      data_t* unitPtr = (data_t*)ptr;
      const data_t blockIndex = unitPtr[ElemSizeInDSize];
      mem_block& block = blocksVector.data[blockIndex];

      if(block.isFull())
	blocksWithFree.push_back(blockIndex);
      block.deallocate(unitPtr);
    }
  };

  template<unsigned ElemSize>
  typename fsb_allocator_elem_allocator<ElemSize>::BlocksVector
  fsb_allocator_elem_allocator<ElemSize>::blocksVector;

  template<unsigned ElemSize>
  std::vector<typename fsb_allocator_elem_allocator<ElemSize>::data_t>
  fsb_allocator_elem_allocator<ElemSize>::blocksWithFree;

#ifdef SL_FSBALLOCATOR_USE_THREAD_SAFE_LOCKING_GCC
  template<unsigned ElemSize>
  volatile int fsb_allocator_elem_allocator<ElemSize>::lockFlag = 0;
#endif


  template<unsigned ElemSize>
  class fsb_allocator2_elem_allocator
  {
    static const size_t BlockElements = 1024;

    static const size_t DSize = sizeof(size_t);
    static const size_t ElemSizeInDSize = (ElemSize + (DSize-1)) / DSize;
    static const size_t BlockSize = BlockElements*ElemSizeInDSize;

    struct Blocks
    {
      std::vector<size_t*> ptrs;

      Blocks()
      {
	ptrs.reserve(256);
	ptrs.push_back(new size_t[BlockSize]);
      }

      ~Blocks()
      {
	for(size_t i = 0; i < ptrs.size(); ++i)
	  delete[] ptrs[i];
      }
    };

    static Blocks blocks;
    static size_t headIndex;
    static size_t* freeList;
    static size_t allocatedElementsAmount;

#ifdef SL_FSBALLOCATOR_USE_THREAD_SAFE_LOCKING_GCC
    volatile static int lockFlag;

    struct Lock
    {
      Lock() { while(!__sync_bool_compare_and_swap(&lockFlag, 0, 1)); }
      ~Lock() { lockFlag = 0; }
    };
#endif

    static void freeAll()
    {
      for(size_t i = 1; i < blocks.ptrs.size(); ++i)
	delete[] blocks.ptrs[i];
      blocks.ptrs.resize(1);
      headIndex = 0;
      freeList = 0;
    }

  public:
    static void* allocate()
    {
#ifdef SL_FSBALLOCATOR_USE_THREAD_SAFE_LOCKING_GCC
      Lock lock;
#endif

      ++allocatedElementsAmount;

      if(freeList)
        {
	  size_t* retval = freeList;
	  freeList = reinterpret_cast<size_t*>(*freeList);
	  return retval;
        }

      if(headIndex == BlockSize)
        {
	  blocks.ptrs.push_back(new size_t[BlockSize]);
	  headIndex = 0;
        }

      size_t* retval = &(blocks.ptrs.back()[headIndex]);
      headIndex += ElemSizeInDSize;
      return retval;
    }

    static void deallocate(void* ptr)
    {
      if(ptr)
        {
#ifdef SL_FSBALLOCATOR_USE_THREAD_SAFE_LOCKING_GCC
	  Lock lock;
#endif

	  size_t* sPtr = (size_t*)ptr;
	  *sPtr = reinterpret_cast<size_t>(freeList);
	  freeList = sPtr;

	  if(--allocatedElementsAmount == 0)
	    freeAll();
        }
    }

    static void cleanSweep(size_t unusedValue = size_t(-1))
    {
#ifdef SL_FSBALLOCATOR_USE_THREAD_SAFE_LOCKING_GCC
      Lock lock;
#endif

      while(freeList)
        {
	  size_t* current = freeList;
	  freeList = reinterpret_cast<size_t*>(*freeList);
	  *current = unusedValue;
        }

      for(size_t i = headIndex; i < BlockSize; i += ElemSizeInDSize)
	blocks.ptrs.back()[i] = unusedValue;

      for(size_t blockInd = 1; blockInd < blocks.ptrs.size();)
        {
	  size_t* block = blocks.ptrs[blockInd];
	  size_t freeAmount = 0;
	  for(size_t i = 0; i < BlockSize; i += ElemSizeInDSize)
	    if(block[i] == unusedValue)
	      ++freeAmount;

	  if(freeAmount == BlockElements)
            {
	      delete[] block;
	      blocks.ptrs[blockInd] = blocks.ptrs.back();
	      blocks.ptrs.pop_back();
            }
	  else ++blockInd;
        }

      const size_t* lastBlock = blocks.ptrs.back();
      for(headIndex = BlockSize; headIndex > 0; headIndex -= ElemSizeInDSize)
	if(lastBlock[headIndex-ElemSizeInDSize] != unusedValue)
	  break;

      const size_t lastBlockIndex = blocks.ptrs.size() - 1;
      for(size_t blockInd = 0; blockInd <= lastBlockIndex; ++blockInd)
        {
	  size_t* block = blocks.ptrs[blockInd];
	  for(size_t i = 0; i < BlockSize; i += ElemSizeInDSize)
            {
	      if(blockInd == lastBlockIndex && i == headIndex)
		break;

	      if(block[i] == unusedValue)
		deallocate(block + i);
            }
        }
    }
  };

  template<unsigned ElemSize>
  typename fsb_allocator2_elem_allocator<ElemSize>::Blocks
  fsb_allocator2_elem_allocator<ElemSize>::blocks;

  template<unsigned ElemSize>
  size_t fsb_allocator2_elem_allocator<ElemSize>::headIndex = 0;

  template<unsigned ElemSize>
  size_t* fsb_allocator2_elem_allocator<ElemSize>::freeList = 0;

  template<unsigned ElemSize>
  size_t fsb_allocator2_elem_allocator<ElemSize>::allocatedElementsAmount = 0;

#ifdef SL_FSBALLOCATOR_USE_THREAD_SAFE_LOCKING_GCC
  template<unsigned ElemSize>
  volatile int fsb_allocator2_elem_allocator<ElemSize>::lockFlag = 0;
#endif


  template<typename Ty>
  class fsb_allocator
  {
  public:
    typedef size_t size_type;
    typedef ptrdiff_t difference_type;
    typedef Ty *pointer;
    typedef const Ty *const_pointer;
    typedef Ty& reference;
    typedef const Ty& const_reference;
    typedef Ty value_type;

    pointer address(reference val) const { return &val; }
    const_pointer address(const_reference val) const { return &val; }

    template<class Other>
    struct rebind
    {
      typedef fsb_allocator<Other> other;
    };

    fsb_allocator() throw() {}

    template<class Other>
    fsb_allocator(const fsb_allocator<Other>&) throw() {}

    template<class Other>
    fsb_allocator& operator=(const fsb_allocator<Other>&) { return *this; }

    pointer allocate(size_type count, const void* = 0)
    {
      if (count!=1) abort();
      return static_cast<pointer>
	(fsb_allocator_elem_allocator<sizeof(Ty)>::allocate());
    }

    void deallocate(pointer ptr, size_type count)
    {
      if (count!=1) abort();
      fsb_allocator_elem_allocator<sizeof(Ty)>::deallocate(ptr);
    }

    void construct(pointer ptr, const Ty& val)
    {
      new ((void *)ptr) Ty(val);
    }

    void destroy(pointer ptr)
    {
      ptr->Ty::~Ty();
    }

    size_type max_size() const throw() { return 1; }
  };


  template<typename Ty>
  class fsb_allocator2
  {
  public:
    typedef size_t size_type;
    typedef ptrdiff_t difference_type;
    typedef Ty *pointer;
    typedef const Ty *const_pointer;
    typedef Ty& reference;
    typedef const Ty& const_reference;
    typedef Ty value_type;

    pointer address(reference val) const { return &val; }
    const_pointer address(const_reference val) const { return &val; }

    template<class Other>
    struct rebind
    {
      typedef fsb_allocator2<Other> other;
    };

    fsb_allocator2() throw() {}

    template<class Other>
    fsb_allocator2(const fsb_allocator2<Other>&) throw() {}

    template<class Other>
    fsb_allocator2& operator=(const fsb_allocator2<Other>&) { return *this; }

    pointer allocate(size_type count, const void* = 0)
    {
      assert(count == 1);
      return static_cast<pointer>
	(fsb_allocator2_elem_allocator<sizeof(Ty)>::allocate());
    }

    void deallocate(pointer ptr, size_type)
    {
      fsb_allocator2_elem_allocator<sizeof(Ty)>::deallocate(ptr);
    }

    void construct(pointer ptr, const Ty& val)
    {
      new ((void *)ptr) Ty(val);
    }

    void destroy(pointer ptr)
    {
      ptr->Ty::~Ty();
    }

    size_type max_size() const throw() { return 1; }

    void cleanSweep(size_t unusedValue = size_t(-1))
    {
      fsb_allocator2_elem_allocator<sizeof(Ty)>::cleanSweep(unusedValue);
    }
  };

  typedef fsb_allocator2<size_t> FSBRefCountAllocator;

} // namespace sl

#endif
